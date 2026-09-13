import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { Str } from "@mahiframework/core";

/**
 * Shared scaffolding helper for the `make:*` generators. Turns a
 * user-supplied name into a `StudlyCase` class name (honouring a required
 * suffix, e.g. `Provider`/`Resource`), renders a template, and writes the
 * file, the `mkdir` + `writeFile` + "Created X" plumbing every generator
 * would otherwise duplicate. Templates stay inline template-literal
 * functions in each command (matching `make-provider.ts`'s existing
 * pattern, no separate `.stub` files).
 */
export interface ScaffoldOptions {
  /** The raw name argument from the CLI (e.g. `post`, `create-post`). */
  name: string;
  /** Directory to write into. */
  dir: string;
  /**
   * A suffix the class name should end with (e.g. `"Provider"`,
   * `"Resource"`, `"Request"`, `"Job"`). If the name already ends with it
   * (case-insensitively) it isn't doubled. Omit for no suffix (e.g.
   * models, events).
   */
  suffix?: string;
  /**
   * Renders the file contents given the computed class name. Kept as a
   * plain function so each command owns its template inline.
   */
  template: (className: string) => string;
  /**
   * Filename (without directory) to write. Defaults to `${className}.ts`.
   * Override for kebab-cased conventions (e.g. `post.model.ts`).
   */
  filename?: (className: string) => string;
  /** Human label used in the "Created X: path" log line (e.g. "model"). */
  label: string;
  /**
   * Overwrite an existing file. Without it, `scaffold()` refuses to
   * clobber a file that already exists (so `make:model User` in a fresh
   * scaffold does not silently wipe the shipped `user.model.ts`). Wired to
   * each generator's `--force`/`-f` flag.
   */
  force?: boolean;
}

/**
 * Thrown when a generator would overwrite an existing file and `--force`
 * was not passed. The kernel renders `error.message` as a single line.
 */
export class FileExistsError extends Error {
  constructor(public readonly filePath: string) {
    super(`${filePath} already exists. Use --force to overwrite.`);
    this.name = "FileExistsError";
  }
}

/** Compute a `StudlyCase` class name from a raw name, applying an optional suffix. */
export function toClassName(name: string, suffix?: string): string {
  const studly = Str.studly(name);

  if (!suffix) {
    return studly;
  }

  return studly.toLowerCase().endsWith(suffix.toLowerCase()) ? studly : `${studly}${suffix}`;
}

/**
 * Write a scaffolded file and log where it went. Returns the absolute-ish
 * path written (as joined from `dir`), for callers/tests that want it.
 */
export async function scaffold(options: ScaffoldOptions): Promise<string> {
  const className = toClassName(options.name, options.suffix);
  await mkdir(options.dir, { recursive: true });

  const filename = options.filename ? options.filename(className) : `${className}.ts`;
  const filePath = path.join(options.dir, filename);

  if (!options.force && existsSync(filePath)) {
    throw new FileExistsError(filePath);
  }

  await writeFile(filePath, options.template(className));

  console.log(`Created ${options.label}: ${filePath}`);

  return filePath;
}
