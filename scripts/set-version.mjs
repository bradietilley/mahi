#!/usr/bin/env node
// Moves every framework package to one version and repoints the
// `create-mahi` template's `@mahi/*` pins at it. All `@mahi/*` packages
// share a version line and are released together.
//
//   node scripts/set-version.mjs 0.2.0     # write
//   node scripts/set-version.mjs --check   # every lockstep package + the
//                                          # template agree on one version
//   node scripts/set-version.mjs --print   # print the lockstep version
//
// `--check` runs in CI; the release workflow also requires the pushed tag
// to equal `v<lockstep version>`.

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const frameworkDir = join(root, "framework");
const templatePackage = join(frameworkDir, "create-mahi", "template", "_package.json");

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const args = process.argv.slice(2);
const check = args.includes("--check");
const print = args.includes("--print");
const target = args.find((a) => !a.startsWith("--"));

if (!check && !print && !target) {
  console.error("usage: set-version.mjs <version> | --check | --print");
  process.exit(2);
}
if (target && !SEMVER.test(target)) {
  console.error(`not a semver version: ${target}`);
  process.exit(2);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

// Collect the lockstep packages.
const packages = [];
for (const entry of readdirSync(frameworkDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const path = join(frameworkDir, entry.name, "package.json");
  if (!existsSync(path)) continue;
  const pkg = readJson(path);
  packages.push({ path, pkg });
}

const versions = new Set(packages.map(({ pkg }) => pkg.version));
const template = readJson(templatePackage);
const templatePins = new Map();
for (const field of ["dependencies", "devDependencies"]) {
  for (const [name, range] of Object.entries(template[field] ?? {})) {
    if (name.startsWith("@mahi/")) templatePins.set(name, range);
  }
}

if (print) {
  if (versions.size !== 1) {
    console.error(`lockstep packages disagree: ${[...versions].join(", ")}`);
    process.exit(1);
  }
  console.log([...versions][0]);
  process.exit(0);
}

if (check) {
  let ok = true;
  if (versions.size !== 1) {
    ok = false;
    console.error(`lockstep packages disagree on a version: ${[...versions].join(", ")}`);
    for (const { pkg } of packages) console.error(`  ${pkg.name}@${pkg.version}`);
  } else {
    const expected = `^${[...versions][0]}`;
    for (const [name, range] of templatePins) {
      if (range !== expected) {
        ok = false;
        console.error(`template pins ${name} at ${range}, expected ${expected}`);
      }
    }
  }
  if (!ok) {
    console.error("\nrun `node scripts/set-version.mjs <version>` to realign");
    process.exit(1);
  }
  console.log(`lockstep version ${[...versions][0]}; template pins in sync`);
  process.exit(0);
}

// Write mode.
for (const { path, pkg } of packages) {
  if (pkg.version === target) continue;
  pkg.version = target;
  writeJson(path, pkg);
  console.log(`${pkg.name}: -> ${target}`);
}

let templateChanged = false;
for (const field of ["dependencies", "devDependencies"]) {
  for (const name of Object.keys(template[field] ?? {})) {
    if (!name.startsWith("@mahi/")) continue;
    const next = `^${target}`;
    if (template[field][name] !== next) {
      template[field][name] = next;
      templateChanged = true;
    }
  }
}
if (templateChanged) {
  writeJson(templatePackage, template);
  console.log(`create-mahi template: @mahi/* pins -> ^${target}`);
}
