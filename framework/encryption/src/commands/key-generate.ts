/**
 * Generates a fresh random 32-byte `APP_KEY` and writes it into `.env`.
 *
 * Auto-writes for convenience (matches Laravel's `artisan key:generate`
 * UX), but only when `.env` has no `APP_KEY` set yet (missing entirely, or
 * present with an empty value), never overwrites an existing key, since
 * doing so would silently make any data already encrypted/hashed with the
 * old key permanently undecryptable/unverifiable. If a key is already
 * set, prints a message and exits without touching the file; pass
 * `--force` to override that safety check and rotate to a new key anyway.
 *
 * Rotation (`--force`) is otherwise Laravel parity: this command only
 * ever touches `APP_KEY` itself, never `APP_PREVIOUS_KEYS`, if
 * already-encrypted/signed data needs to stay readable under the old key,
 * manually copy the outgoing `APP_KEY` value into `APP_PREVIOUS_KEYS`
 * (comma-separated if more than one) *before* running `--force`, since
 * this command has no way to recover the old key afterward. `Encrypter`/
 * `Signer` (see `EncryptionServiceProvider`) automatically fall back to
 * trying each key in `APP_PREVIOUS_KEYS` on decrypt/verify.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Command as CommanderCommand } from "commander";
import { Command } from "@mahiframework/cli";

function generateKey(): string {
  return `base64:${randomBytes(32).toString("base64")}`;
}

/** Reads the current value of `APP_KEY=` from `.env` content, if set and non-empty. */
function existingAppKey(content: string): string | undefined {
  const match = content.match(/^APP_KEY=(.*)$/m);
  const value = match?.[1]?.trim();

  return value ? value : undefined;
}

function setAppKey(content: string, key: string): string {
  if (/^APP_KEY=.*$/m.test(content)) {
    return content.replace(/^APP_KEY=.*$/m, `APP_KEY=${key}`);
  }

  const withTrailingNewline =
    content.length > 0 && !content.endsWith("\n") ? `${content}\n` : content;

  return `${withTrailingNewline}APP_KEY=${key}\n`;
}

export class KeyGenerateCommand extends Command {
  signature = "key:generate";
  description = "Generate a new APP_KEY and write it into .env (unless one is already set).";

  configure(program: CommanderCommand): void {
    program
      .option("-p, --path <path>", "Path to the .env file", ".env")
      .option("-f, --force", "Overwrite an existing APP_KEY", false);
  }

  async handle(options: { path: string; force: boolean }): Promise<void> {
    const key = generateKey();
    const content = existsSync(options.path) ? readFileSync(options.path, "utf-8") : "";
    const current = existingAppKey(content);

    if (current && !options.force) {
      console.log(
        `APP_KEY is already set in ${options.path} — leaving it unchanged. Pass --force to rotate it.`,
      );

      return;
    }

    writeFileSync(options.path, setAppKey(content, key));
    console.log(`${current ? "Rotated" : "Wrote"} APP_KEY in ${options.path}.`);
  }
}
