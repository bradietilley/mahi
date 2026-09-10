import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Root for temp migration directories, deliberately INSIDE this package
 * (`framework/cli/.tmp-tests/`) rather than the OS temp dir.
 *
 * The migration files these tests write out `import { Schema } from
 * "@mahi/database"`, and `MigrationRunner.discover()` loads them
 * with a bare dynamic `import()`. That's resolved by **Node**, against
 * the importing file's own location — so a migration sitting in
 * `/var/folders/.../T/` has no `node_modules` anywhere up its parent
 * chain and the bare specifier fails with `Cannot find package
 * '@mahi/database'`.
 *
 * Keeping the fixtures under this package means the normal
 * `framework/cli/node_modules/@mahi/database` symlink is on the
 * resolution path, exactly as it is for a real app's `database/
 * migrations/` directory. (Older vitest happened to route these imports
 * through Vite's resolver, which followed the *test file's* location and
 * masked the problem; Node's native ESM loader does not.)
 */
const FIXTURE_ROOT = path.join(fileURLToPath(new URL("../../", import.meta.url)), ".tmp-tests");

/** Creates an empty, uniquely-named migrations directory that bare `@mahi/*` imports resolve from. */
export async function makeMigrationDir(prefix: string): Promise<string> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(FIXTURE_ROOT, { recursive: true });

  return mkdtemp(path.join(FIXTURE_ROOT, `${prefix}-`));
}

/** Removes a directory created by `makeMigrationDir()`. */
export async function removeMigrationDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
