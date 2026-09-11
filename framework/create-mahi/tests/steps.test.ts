import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  StepError,
  copyTemplate,
  createDatabaseFile,
  directoryIsUsable,
  patchPackageJson,
  writeEnvFile,
} from "../src/steps.js";

const TEMPLATE_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "template");

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "create-mahi-test-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("directoryIsUsable", () => {
  it("is true for a directory that does not exist", async () => {
    expect(await directoryIsUsable(path.join(tmp, "nope"))).toBe(true);
  });

  it("is true for an empty directory", async () => {
    expect(await directoryIsUsable(tmp)).toBe(true);
  });

  it("tolerates a lone .git — scaffolding into a fresh clone is normal", async () => {
    await mkdir(path.join(tmp, ".git"));
    expect(await directoryIsUsable(tmp)).toBe(true);
  });

  it("is false once there is real content", async () => {
    await writeFile(path.join(tmp, "README.md"), "");
    expect(await directoryIsUsable(tmp)).toBe(false);
  });

  it("reports a friendly error when the target path is a file, not a directory", async () => {
    const file = path.join(tmp, "not-a-dir");
    await writeFile(file, "");
    await expect(directoryIsUsable(file)).rejects.toBeInstanceOf(StepError);
    await expect(directoryIsUsable(file)).rejects.toThrow(/is a file, not a directory/);
  });
});

describe("copyTemplate", () => {
  /**
   * The underscore-prefixed names exist because npm rewrites a published
   * `.gitignore` to `.npmignore`, and a nested `package.json` would make
   * package managers treat `template/` as its own project. If the rename
   * ever stops happening, a generated app has no manifest at all.
   */
  it("renames the underscore-prefixed files and removes the originals", async () => {
    const target = path.join(tmp, "app");
    await copyTemplate(TEMPLATE_DIR, target);

    for (const file of ["package.json", ".gitignore", ".env.example", ".dockerignore"]) {
      expect(await exists(path.join(target, file))).toBe(true);
    }

    for (const file of ["_package.json", "_gitignore", "_env.example", "_dockerignore"]) {
      expect(await exists(path.join(target, file))).toBe(false);
    }
  });

  it("copies the application source tree", async () => {
    const target = path.join(tmp, "app");
    await copyTemplate(TEMPLATE_DIR, target);

    for (const file of [
      "artisan",
      "tsconfig.json",
      "bin/bootstrap.ts",
      "config/app.ts",
      "src/models/user.model.ts",
      "src/providers/app.provider.ts",
      "database/migrations/2026_01_01_000000_create_users_table.ts",
      "tests/auth.test.ts",
    ]) {
      expect(await exists(path.join(target, file))).toBe(true);
    }
  });

  it("leaves ./artisan executable", async () => {
    const target = path.join(tmp, "app");
    await copyTemplate(TEMPLATE_DIR, target);

    const mode = (await stat(path.join(target, "artisan"))).mode;
    expect(mode & 0o111).not.toBe(0);
  });

  it("ships no demo models or routes", async () => {
    const target = path.join(tmp, "app");
    await copyTemplate(TEMPLATE_DIR, target);

    for (const file of [
      "src/models/post.model.ts",
      "src/models/like.model.ts",
      "src/routes/posts.routes.ts",
    ]) {
      expect(await exists(path.join(target, file))).toBe(false);
    }
  });
});

describe("patchPackageJson", () => {
  it("sets the project name", async () => {
    const target = path.join(tmp, "app");
    await copyTemplate(TEMPLATE_DIR, target);
    await patchPackageJson(target, { name: "my-app", linkWorkspace: false });

    expect(await readJson(target)).toMatchObject({ name: "my-app" });
  });

  it("leaves published version ranges alone by default", async () => {
    const target = path.join(tmp, "app");
    await copyTemplate(TEMPLATE_DIR, target);
    await patchPackageJson(target, { name: "my-app", linkWorkspace: false });

    const pkg = await readJson(target);
    expect(pkg.dependencies["@mahi/core"]).toMatch(/^\^/);
  });

  it("rewrites every @mahi dependency to workspace:* when linking", async () => {
    const target = path.join(tmp, "app");
    await copyTemplate(TEMPLATE_DIR, target);
    await patchPackageJson(target, { name: "my-app", linkWorkspace: true });

    const pkg = await readJson(target);

    for (const [name, range] of Object.entries(pkg.dependencies)) {
      if (name.startsWith("@mahi/")) {
        expect(range).toBe("workspace:*");
      }
    }

    expect(pkg.devDependencies["@mahi/testing"]).toBe("workspace:*");
    // Third-party deps must not be touched.
    expect(pkg.dependencies["zod"]).toMatch(/^\^/);
  });
});

describe("writeEnvFile", () => {
  it("copies .env.example to .env", async () => {
    const target = path.join(tmp, "app");
    await copyTemplate(TEMPLATE_DIR, target);
    await writeEnvFile(target);

    const env = await readFile(path.join(target, ".env"), "utf-8");
    expect(env).toContain("DB_FILENAME=database/database.sqlite");
    expect(env).toContain("APP_KEY=");
  });

  it("never clobbers an existing .env", async () => {
    const target = path.join(tmp, "app");
    await copyTemplate(TEMPLATE_DIR, target);
    await writeFile(path.join(target, ".env"), "APP_KEY=base64:existing\n");
    await writeEnvFile(target);

    expect(await readFile(path.join(target, ".env"), "utf-8")).toBe("APP_KEY=base64:existing\n");
  });
});

describe("createDatabaseFile", () => {
  it("creates the sqlite file at the documented path", async () => {
    const target = path.join(tmp, "app");
    await copyTemplate(TEMPLATE_DIR, target);
    await createDatabaseFile(target);

    expect(await exists(path.join(target, "database", "database.sqlite"))).toBe(true);
  });

  it("does not truncate an existing database", async () => {
    const target = path.join(tmp, "app");
    await mkdir(path.join(target, "database"), { recursive: true });
    const file = path.join(target, "database", "database.sqlite");
    await writeFile(file, "existing");

    await createDatabaseFile(target);

    expect(await readFile(file, "utf-8")).toBe("existing");
  });
});

/**
 * A developer setting up an app copies `.env.example` and fills it in. If a
 * key the app actually reads (`config/env.ts`) isn't listed there — even
 * commented out — it's invisible: the developer never learns it exists
 * until an `undefined` surfaces at runtime. This asserts every schema key
 * appears somewhere in `.env.example` (uncommented `KEY=` or a `# KEY=`
 * hint), so the example stays a superset of what the app understands.
 */
describe(".env.example parity with config/env.ts", () => {
  it("documents every key the env schema reads", async () => {
    const example = await readFile(path.join(TEMPLATE_DIR, "_env.example"), "utf-8");
    const envTs = await readFile(path.join(TEMPLATE_DIR, "config", "env.ts"), "utf-8");

    // Keys declared in the zod schema: `KEY: z....`. Uppercase snake-case
    // only, which every real env var in the schema is.
    const schemaKeys = [...envTs.matchAll(/^\s{2}([A-Z][A-Z0-9_]*)\s*:/gm)].map((m) => m[1]);
    expect(schemaKeys.length).toBeGreaterThan(0);

    // Keys mentioned in the example, whether live (`KEY=`) or a commented
    // hint (`# KEY=`).
    const documented = new Set(
      [...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]),
    );

    const missing = schemaKeys.filter((key) => !documented.has(key));
    expect(missing, `.env.example is missing: ${missing.join(", ")}`).toEqual([]);
  });
});

/**
 * Every `@mahi/*` the template imports must be declared in
 * `_package.json`, and vice versa.
 *
 * This is invisible to every local check and to the CI scaffold smoke
 * test: those install into the pnpm workspace, where an undeclared
 * `@mahi/*` still resolves by hoisting. A real `npm create mahi` gets
 * only the declared dependencies, so an undeclared import is a
 * `TS2307` on the user's very first `tsc -b` — which is exactly what
 * happened to `@mahi/datetime`, pruned as unused by one commit and
 * re-imported by the next.
 *
 * A static check rather than an install: no network, runs in
 * milliseconds on every `pnpm test`, and fails at the precise cause.
 */
describe("template dependency completeness", () => {
  it("declares every @mahi/* package it imports, and imports every one it declares", async () => {
    const manifest = JSON.parse(await readFile(path.join(TEMPLATE_DIR, "_package.json"), "utf-8"));
    const declared = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ]);

    const imported = new Set<string>();

    for (const file of await sourceFiles(TEMPLATE_DIR)) {
      const source = await readFile(file, "utf-8");

      // `from "@mahi/x"` and `import("@mahi/x")` — the two forms the
      // template uses. Deliberately not matching prose in comments.
      for (const match of source.matchAll(/(?:from|import\()\s*["'](@mahi\/[a-z-]+)["']/g)) {
        imported.add(match[1]!);
      }
    }

    expect(imported.size).toBeGreaterThan(0);

    const undeclared = [...imported].filter((dep) => !declared.has(dep)).sort();
    expect(
      undeclared,
      `imported but not in _package.json (a real \`npm create mahi\` would fail \`tsc -b\`): ${undeclared.join(", ")}`,
    ).toEqual([]);

    const unused = [...declared]
      .filter((dep) => dep.startsWith("@mahi/") && !imported.has(dep))
      .sort();
    expect(unused, `declared but never imported: ${unused.join(", ")}`).toEqual([]);
  });

  // The pins themselves are checked by `scripts/set-version.mjs --check`,
  // which knows which packages are on the lockstep line and which
  // (`@mahi/datetime`) version independently. Duplicating that here would
  // only encode a second, wronger copy of the rule.
});

/** Every `.ts` file under the template, recursively. */
async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];

  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") {
      continue;
    }

    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      out.push(...(await sourceFiles(full)));
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }

  return out;
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);

    return true;
  } catch {
    return false;
  }
}

async function readJson(target: string): Promise<any> {
  return JSON.parse(await readFile(path.join(target, "package.json"), "utf-8"));
}
