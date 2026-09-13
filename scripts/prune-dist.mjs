#!/usr/bin/env node
// Removes compiled outputs in a package's `dist/` that no longer have a
// source file under `src/`. `tsc -b` only ever adds or overwrites outputs;
// when a source file is deleted or renamed its stale `.js`/`.d.ts` stays
// behind, still importable, still shipped by `files: ["dist"]`, and still
// referencing whatever the code looked like at the time. Run after every
// build (the package `build` script does) so a tarball only ever contains
// what the current sources produce.
//
//   node ../../scripts/prune-dist.mjs           # prune (from a package dir)
//   node ../../scripts/prune-dist.mjs --check   # fail if anything is stale

import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";

const pkgDir = process.cwd();
const srcDir = join(pkgDir, "src");
const distDir = join(pkgDir, "dist");
const check = process.argv.includes("--check");

if (!existsSync(distDir) || !existsSync(srcDir)) process.exit(0);

// Output suffix -> the source extensions that could have produced it.
const OUTPUTS = [
  [".d.ts.map", [".ts", ".tsx", ".mts"]],
  [".d.ts", [".ts", ".tsx", ".mts"]],
  [".js.map", [".ts", ".tsx", ".mts"]],
  [".js", [".ts", ".tsx", ".mts", ".js"]],
  [".json", [".json"]],
];

function hasSource(relPath) {
  for (const [suffix, sourceExts] of OUTPUTS) {
    if (!relPath.endsWith(suffix)) continue;
    const base = relPath.slice(0, -suffix.length);
    return sourceExts.some((ext) => existsSync(join(srcDir, base + ext)));
  }
  // Unknown output kind (asset copied by some other step), leave it alone.
  return true;
}

const stale = [];

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      if (readdirSync(full).length === 0) {
        if (check) stale.push(relative(pkgDir, full) + "/");
        else rmSync(full, { recursive: true });
      }
      continue;
    }
    const rel = relative(distDir, full);
    if (hasSource(rel)) continue;
    stale.push(relative(pkgDir, full));
    if (!check) rmSync(full);
  }
}

walk(distDir);

if (stale.length === 0) process.exit(0);

if (check) {
  console.error(`stale build outputs with no source (run the package build to prune):`);
  for (const file of stale) console.error(`  ${file}`);
  process.exit(1);
}

for (const file of stale) console.log(`pruned: ${file}`);
