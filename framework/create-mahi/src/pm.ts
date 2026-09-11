/**
 * Package-manager detection and command shapes.
 *
 * `npm create` / `pnpm create` / `yarn create` / `bun create` all set
 * `npm_config_user_agent` on the spawned process, which is the only
 * reliable signal for "which tool did the user actually type". Falling
 * back to npm is safe: it's the one that's always present.
 */

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export const PACKAGE_MANAGERS: readonly PackageManager[] = ["npm", "pnpm", "yarn", "bun"];

export function isPackageManager(value: string): value is PackageManager {
  return (PACKAGE_MANAGERS as readonly string[]).includes(value);
}

/**
 * Read the package manager out of `npm_config_user_agent`, whose format is
 * `"<name>/<version> node/<version> <platform> <arch>"`.
 */
export function detectPackageManager(
  userAgent = process.env.npm_config_user_agent,
): PackageManager {
  if (!userAgent) {
    return "npm";
  }

  const name = userAgent.split(" ")[0]?.split("/")[0];

  return name !== undefined && isPackageManager(name) ? name : "npm";
}

/** The argv for installing all dependencies in a project directory. */
export function installCommand(pm: PackageManager): [string, string[]] {
  return [pm, ["install"]];
}

/**
 * How a user runs a script with this package manager, for the closing
 * "next steps" hint. `npm` is the odd one out in needing `run` for
 * anything that isn't a lifecycle script.
 */
export function runScript(pm: PackageManager, script: string): string {
  return pm === "npm" ? `npm run ${script}` : `${pm} ${script}`;
}
