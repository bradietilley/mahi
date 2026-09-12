#!/usr/bin/env node
import path from "node:path";
import { access, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { Tui, colors } from "@mahiframework/tui";
import { detectPackageManager, runScript } from "./pm.js";
import { parseArgs, isValidProjectName, toProjectName } from "./options.js";
import {
  StepError,
  artisan,
  copyTemplate,
  createDatabaseFile,
  directoryIsUsable,
  initGitRepository,
  installDependencies,
  isInsideGitRepository,
  patchPackageJson,
  writeEnvFile,
} from "./steps.js";

const USAGE = `
${colors.bold("create-mahi")} — scaffold a new Mahi application

${colors.bold("Usage")}
  npm create mahi@latest <directory> [options]

${colors.bold("Options")}
  --pm <npm|pnpm|yarn|bun>   Package manager (default: auto-detected)
  --no-install               Skip installing dependencies
  --no-migrate               Skip the initial database migration
  --no-git                   Skip git initialisation
  --link-workspace           Point @mahiframework/* at workspace:* (monorepo development)
  --force                    Scaffold into a non-empty directory
  -y, --yes                  Accept defaults without prompting
  -h, --help                 Show this message
`;

/** Whether a path exists at all (file or directory). */
async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK);

    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(USAGE);

    return;
  }

  const options = parseArgs(argv);

  Tui.intro(" create-mahi ");

  const directory =
    options.directory ??
    (options.yes
      ? "mahi-app"
      : await Tui.ask("Where should the application be created?", {
          default: "mahi-app",
          placeholder: "mahi-app",
          required: true,
        }));

  const target = path.resolve(process.cwd(), directory);
  const projectName = toProjectName(path.basename(target));

  if (!isValidProjectName(projectName)) {
    throw new StepError(`"${projectName}" is not a valid package name.`);
  }

  if (!options.force && !(await directoryIsUsable(target))) {
    throw new StepError(`${target} is not empty. Use --force to scaffold into it anyway.`);
  }

  const pm = options.pm ?? detectPackageManager();
  const templateDir = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "template");

  // A run that dies mid-scaffold otherwise leaves a half-written tree
  // behind, which then trips the "directory not empty" guard on the retry.
  // Only a target this run CREATED is safe to remove on failure — never a
  // pre-existing directory a user pointed `--force` at.
  const targetExisted = await pathExists(target);
  let scaffolded = false;
  let installed = false;

  try {
    await Tui.task("Creating project files", async () => {
      await copyTemplate(templateDir, target);
      scaffolded = true;
      await patchPackageJson(target, { name: projectName, linkWorkspace: options.linkWorkspace });
    });

    await Tui.task("Creating .env", () => writeEnvFile(target));
    await Tui.task("Creating database file", () => createDatabaseFile(target));

    if (options.install) {
      await Tui.task(`Installing dependencies (${pm})`, () => installDependencies(target, pm));
      installed = true;
    } else {
      Tui.taskLine("Installing dependencies", "skipped");
    }

    // Both of these shell out to `./artisan`, which needs `tsx` and the
    // framework packages present — so they're only possible post-install.
    if (installed) {
      await Tui.task("Generating application key", () => artisan(target, ["key:generate"]));
    } else {
      Tui.taskLine("Generating application key", "skipped");
    }

    if (installed && options.migrate) {
      await Tui.task("Running migrations", () => artisan(target, ["migrate"]));
    } else {
      Tui.taskLine("Running migrations", "skipped");
    }

    if (options.git && !(await isInsideGitRepository(target))) {
      await Tui.task("Initialising git repository", () => initGitRepository(target));
    }
  } catch (error) {
    // Roll back a directory this run created, so the failure leaves the
    // filesystem as it found it and a corrected retry isn't blocked by
    // "directory not empty". A `--force` into an existing directory is left
    // untouched — we can't know which files were the user's.
    if (scaffolded && !targetExisted) {
      await rm(target, { recursive: true, force: true }).catch(() => {});
    }

    throw error;
  }

  Tui.outro(" Your Mahi application is ready ");

  const relative = path.relative(process.cwd(), target) || ".";
  const steps = [`cd ${relative}`];

  if (!installed) {
    steps.push(`${pm} install`, "./artisan key:generate", "./artisan migrate");
  }

  steps.push("./artisan serve");

  console.log("Next steps:\n");

  for (const step of steps) {
    console.log(`  ${colors.cyan(step)}`);
  }

  console.log(`\nRun ${colors.cyan("./artisan --help")} to see every available command.`);
  console.log(`Tests: ${colors.cyan(runScript(pm, "test"))}\n`);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  Tui.error(message);
  process.exitCode = 1;
}
