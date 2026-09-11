import { isPackageManager, type PackageManager } from "./pm.js";
import { StepError } from "./steps.js";

export interface Options {
  directory?: string;
  pm?: PackageManager;
  install: boolean;
  migrate: boolean;
  git: boolean;
  linkWorkspace: boolean;
  force: boolean;
  yes: boolean;
}

/**
 * Hand-rolled rather than pulled from Commander: this package is what a
 * user runs *before* they have any dependencies installed, so its own
 * install should be as close to zero as possible. The flag set is small
 * and closed.
 */
export function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    install: true,
    migrate: true,
    git: true,
    linkWorkspace: false,
    force: false,
    yes: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    switch (arg) {
      case "--no-install":
        options.install = false;
        break;
      case "--no-migrate":
        options.migrate = false;
        break;
      case "--no-git":
        options.git = false;
        break;
      case "--link-workspace":
        options.linkWorkspace = true;
        break;
      case "--force":
        options.force = true;
        break;
      case "-y":
      case "--yes":
        options.yes = true;
        break;
      case "--pm": {
        const value = argv[++i];

        if (value === undefined || !isPackageManager(value)) {
          throw new StepError("--pm expects one of: npm, pnpm, yarn, bun");
        }

        options.pm = value;
        break;
      }
      default: {
        if (arg.startsWith("--pm=")) {
          const value = arg.slice("--pm=".length);

          if (!isPackageManager(value)) {
            throw new StepError("--pm expects one of: npm, pnpm, yarn, bun");
          }

          options.pm = value;
          break;
        }

        if (arg.startsWith("-")) {
          throw new StepError(`Unknown option: ${arg}`);
        }

        if (options.directory !== undefined) {
          throw new StepError(`Unexpected argument: ${arg}`);
        }

        options.directory = arg;
      }
    }
  }

  return options;
}

/**
 * npm package name rules, minus the scope handling — a scaffolded app is
 * always unscoped, and the name is only ever written into its own
 * private `package.json`.
 */
export function isValidProjectName(name: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/.test(name) && name.length <= 214;
}

/** Turn an arbitrary directory name into something npm will accept. */
export function toProjectName(dirName: string): string {
  const normalized = dirName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+/, "")
    .replace(/-+$/, "");

  return normalized === "" ? "mahi-app" : normalized;
}
