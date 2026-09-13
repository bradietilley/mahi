import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { PackageManager } from "./pm.js";
import { installCommand } from "./pm.js";

/**
 * Files that can't ship under their real names.
 *
 * npm unconditionally renames `.gitignore` to `.npmignore` inside a
 * published tarball, and a nested `package.json` makes package managers
 * and monorepo tooling treat `template/` as a workspace of its own. Both
 * are shipped with an underscore prefix and renamed on copy.
 */
const TEMPLATE_RENAMES: Record<string, string> = {
  "_package.json": "package.json",
  _gitignore: ".gitignore",
  "_env.example": ".env.example",
  _dockerignore: ".dockerignore",
};

export class StepError extends Error {}

/**
 * True when `dir` doesn't exist, or exists and contains nothing that
 * would be clobbered. A lone `.git` is tolerated, cloning an empty repo
 * and scaffolding into it is a normal flow.
 */
export async function directoryIsUsable(dir: string): Promise<boolean> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (code === "ENOENT") {
      return true;
    }

    // The path exists but is a FILE, not a directory. `readdir` throws a
    // raw `ENOTDIR` here. Turn it into something a user can act on rather
    // than leaking the errno through the top-level handler.
    if (code === "ENOTDIR") {
      throw new StepError(`${dir} is a file, not a directory — choose a different target.`);
    }

    throw error;
  }

  return entries.filter((entry) => entry !== ".git").length === 0;
}

/** Recursively copy `template/` into `target`, applying the underscore renames. */
export async function copyTemplate(templateDir: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  await cp(templateDir, target, { recursive: true });

  for (const [from, to] of Object.entries(TEMPLATE_RENAMES)) {
    const source = path.join(target, from);

    if (!(await exists(source))) {
      continue;
    }

    await copyFile(source, path.join(target, to));
    await rm(source, { force: true });
  }

  // `cp` preserves mode, but a published tarball may not, make sure
  // `./artisan` is executable regardless of how the template arrived.
  const artisan = path.join(target, "artisan");

  if (await exists(artisan)) {
    await chmod(artisan, 0o755);
  }
}

/**
 * Set the project name, and, with `linkWorkspace`, repoint every
 * `@mahiframework/*` dependency at `workspace:*` so an app scaffolded inside the
 * framework monorepo resolves against the local packages rather than the
 * registry.
 */
export async function patchPackageJson(
  target: string,
  options: { name: string; linkWorkspace: boolean },
): Promise<void> {
  const file = path.join(target, "package.json");
  const pkg = JSON.parse(await readFile(file, "utf-8")) as {
    name?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  pkg.name = options.name;

  if (options.linkWorkspace) {
    for (const key of ["dependencies", "devDependencies"] as const) {
      const deps = pkg[key];

      if (!deps) {
        continue;
      }

      for (const dep of Object.keys(deps)) {
        if (dep.startsWith("@mahiframework/")) {
          deps[dep] = "workspace:*";
        }
      }
    }
  }

  await writeFile(file, `${JSON.stringify(pkg, null, 2)}\n`);
}

/** Copy `.env.example` to `.env` when there isn't one already. */
export async function writeEnvFile(target: string): Promise<void> {
  const env = path.join(target, ".env");

  if (await exists(env)) {
    return;
  }

  await copyFile(path.join(target, ".env.example"), env);
}

/**
 * Create the SQLite file. `better-sqlite3` would create it on first
 * connect anyway, but doing it here means a `--no-migrate` scaffold still
 * leaves a coherent tree, and it surfaces a permissions problem now
 * rather than at the first request.
 */
export async function createDatabaseFile(target: string): Promise<void> {
  const file = path.join(target, "database", "database.sqlite");

  if (await exists(file)) {
    return;
  }

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "");
}

export async function initGitRepository(target: string): Promise<void> {
  await run("git", ["init", "--quiet"], target);
  await run("git", ["add", "-A"], target);
  await run(
    "git",
    [
      "-c",
      "user.name=Mahi",
      "-c",
      "user.email=create-mahi@localhost",
      "commit",
      "--quiet",
      "-m",
      "Initial commit",
    ],
    target,
  );
}

export async function isInsideGitRepository(target: string): Promise<boolean> {
  try {
    await run("git", ["rev-parse", "--is-inside-work-tree"], target);

    return true;
  } catch {
    return false;
  }
}

export async function installDependencies(target: string, pm: PackageManager): Promise<void> {
  const [command, args] = installCommand(pm);
  await run(command, args, target);
}

/** Run an artisan command in the scaffolded app. */
export async function artisan(target: string, args: string[]): Promise<void> {
  await run("./artisan", args, target);
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file, constants.F_OK);

    return true;
  } catch {
    return false;
  }
}

/**
 * Spawn a command, capturing output so a failure can report it. Nothing
 * is inherited to the terminal: the TUI owns the screen, and a package
 * manager's progress bars fighting a spinner looks broken.
 */
export function run(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

    child.on("error", (error) => reject(new StepError(`${command}: ${error.message}`)));
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);

        return;
      }

      const output = (stderr || stdout).trim();
      reject(new StepError(`\`${command} ${args.join(" ")}\` failed (exit ${code}).\n${output}`));
    });
  });
}
