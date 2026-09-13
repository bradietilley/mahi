import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SnowflakeException } from "../errors.js";
import type { SequenceResolver } from "./sequence-resolver.js";

/**
 * File-locked sequence counter for multi-process apps that share a worker
 * id without Redis. Mirrors php-snowflake's `FileSequenceResolver`: an
 * exclusive lock (a sibling `.lock` file, since Node has no portable
 * `flock`), a JSON map of `{ [microsecond]: sequence }`, and GC of
 * entries older than one second.
 *
 * The stored sequence is incremented then returned, so the first ID in a
 * given microsecond gets sequence `1` (not `0`), matching PHP, so a
 * shared sequence file is interoperable across languages.
 */
export class FileSequenceResolver implements SequenceResolver {
  /** Attempt to acquire the lock for up to 1.5 seconds, matching PHP. */
  static readonly LOCK_TIMEOUT_MS = 1500;

  constructor(public readonly file: string) {}

  async sequence(currentTime: number): Promise<number> {
    const lockPath = `${this.file}.lock`;
    await this.acquireLock(lockPath);

    try {
      const times = this.getContents();
      this.gc(times, currentTime);

      const key = String(currentTime);
      times[key] = (times[key] ?? 0) + 1;
      this.putContents(times);

      return times[key]!;
    } finally {
      this.releaseLock(lockPath);
    }
  }

  protected async acquireLock(lockPath: string): Promise<void> {
    const directory = dirname(this.file);

    if (directory && !existsSync(directory)) {
      mkdirSync(directory, { recursive: true });
    }

    if (!existsSync(this.file)) {
      writeFileSync(this.file, "");
    }

    const started = Date.now();

    while (Date.now() - started < FileSequenceResolver.LOCK_TIMEOUT_MS) {
      try {
        writeFileSync(lockPath, String(process.pid), { flag: "wx" });

        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;

        if (code !== "EEXIST") {
          throw new SnowflakeException(`can not open/lock this file ${this.file}`);
        }

        try {
          const age = Date.now() - statSync(lockPath).mtimeMs;

          if (age > FileSequenceResolver.LOCK_TIMEOUT_MS) {
            unlinkSync(lockPath);
            continue;
          }
        } catch {
          // Lock vanished between EEXIST and stat, retry immediately.
          continue;
        }

        await delay(1);
      }
    }

    throw new SnowflakeException(`can not open/lock this file ${this.file}`);
  }

  protected releaseLock(lockPath: string): void {
    try {
      unlinkSync(lockPath);
    } catch {
      // Lock file already gone, another process recovered, or we never acquired it.
    }
  }

  protected getContents(): Record<string, number> {
    if (!existsSync(this.file)) {
      return {};
    }

    const content = readFileSync(this.file, "utf8").trim();

    if (content === "") {
      return {};
    }

    try {
      const data = JSON.parse(content) as unknown;

      if (data === null || typeof data !== "object" || Array.isArray(data)) {
        return {};
      }

      return data as Record<string, number>;
    } catch {
      return {};
    }
  }

  protected putContents(times: Record<string, number>): void {
    writeFileSync(this.file, JSON.stringify(times));
  }

  protected gc(times: Record<string, number>, currentTime: number): void {
    const prevSecond = currentTime - 1_000_000;

    for (const key of Object.keys(times)) {
      if (Number(key) < prevSecond) {
        delete times[key];
      }
    }
  }
}
