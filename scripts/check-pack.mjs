#!/usr/bin/env node
// Dry-run `npm pack` for every workspace package and fail if a tarball would
// ship anything other than the built output and the three manifest files.
// Guards `files` in package.json (and the prune step in `build`) against
// drift, so a stray `src/`, `tests/`, `.turbo/` or `tsconfig.tsbuildinfo`
// cannot reach npm.
//
//   node scripts/check-pack.mjs

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const frameworkDir = join(root, "framework");

const ALWAYS_ALLOWED = new Set(["package.json", "README.md", "LICENSE"]);

/** Extra top-level directories a specific package legitimately ships. */
const EXTRA_DIRS = {
  "create-mahi": ["template/"],
};

let failed = false;

for (const entry of readdirSync(frameworkDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const pkgDir = join(frameworkDir, entry.name);
  const pkgPath = join(pkgDir, "package.json");
  if (!existsSync(pkgPath)) continue;

  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  if (pkg.private) continue;

  const raw = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: pkgDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const [result] = JSON.parse(raw);
  const files = result.files.map((f) => f.path);

  const allowedDirs = ["dist/", ...(EXTRA_DIRS[entry.name] ?? [])];
  const stray = files.filter(
    (f) => !ALWAYS_ALLOWED.has(f) && !allowedDirs.some((d) => f.startsWith(d)),
  );
  const missing = [...ALWAYS_ALLOWED, "dist/index.js"].filter((f) => !files.includes(f));

  if (stray.length || missing.length) {
    failed = true;
    console.error(`${pkg.name}@${pkg.version}:`);
    for (const f of stray) console.error(`  stray:   ${f}`);
    for (const f of missing) console.error(`  missing: ${f}`);
  } else {
    console.log(`${pkg.name}@${pkg.version}: ${files.length} files ok`);
  }
}

if (failed) {
  console.error("\ntarball contents drifted — fix `files` in package.json or rebuild");
  process.exit(1);
}
