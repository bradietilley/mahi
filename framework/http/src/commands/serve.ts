import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { once } from "node:events";
import path from "node:path";
import type { Command as CommanderCommand } from "commander";
import { Command, isCompiledBinary, trap } from "@mahiframework/cli";
import { base_path, type Application } from "@mahiframework/core";
import { bindWithRetries, type ListeningServer } from "../listen.js";
import {
  formatServeUrl,
  nodeHostname,
  resolveServeBinding,
  SERVE_WORKER_ENV,
  shouldSupervise,
  type ServeBinding,
  type ServeOptions,
} from "./serve-binding.js";

const ENV_POLL_MS = 500;

function parseTries(options: ServeOptions): number {
  const parsed = Number(options.tries ?? 10);

  return Number.isInteger(parsed) && parsed >= 0 ? Math.max(1, parsed) : 10;
}

function envMtime(envFile: string): number | undefined {
  if (!existsSync(envFile)) {
    return undefined;
  }

  return statSync(envFile).mtimeMs;
}

/**
 * Bind the already-booted Application and return the listening server
 * without waiting for SIGINT — used by the worker path and by tests.
 */
export async function startServeWorker(
  app: Application,
  options: ServeOptions,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ListeningServer> {
  const binding = resolveServeBinding(options, env);

  return bindWithRetries(app, {
    hostname: nodeHostname(binding.hostname),
    port: binding.port,
    attempts: binding.portWasExplicit ? 1 : parseTries(options),
  });
}

function waitUntilStopped(listening: ListeningServer): Promise<void> {
  return new Promise((resolve) => {
    const untrap = trap(["SIGINT", "SIGTERM"], () => {
      untrap();
      void listening.close().finally(resolve);
    });
  });
}

function childIsRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (!childIsRunning(child)) {
    return;
  }

  await once(child, "exit");
}

/**
 * Path to `tsx/dist/cli.mjs` — the real Node entry, not `node_modules/.bin/tsx`.
 * The bin file is a POSIX shim; `spawn(process.execPath, [shim, console.ts])`
 * makes Node run `console.ts` natively, which does not rewrite `.js` imports
 * to `.ts` and fails with `Cannot find module '.../bootstrap.js'`.
 */
export function resolveTsxCli(cwd = process.cwd()): string | undefined {
  const candidates = [
    path.join(cwd, "node_modules", "tsx", "dist", "cli.mjs"),
    path.join(cwd, "..", "node_modules", "tsx", "dist", "cli.mjs"),
  ];

  return candidates.find((candidate) => existsSync(candidate));
}

/**
 * The arguments the supervisor should re-execute itself with, to be passed to
 * `spawn(process.execPath, ...)`.
 *
 * Three shapes, because `process.execPath` means something different in each:
 *
 * | Running as | `execPath` | args |
 * |---|---|---|
 * | `./artisan serve` (tsx) | `node` | `[tsx/cli.mjs, bin/console.ts, serve, ...]` |
 * | `node dist/bin/console.js serve` | `node` | `[dist/bin/console.js, serve, ...]` |
 * | a compiled binary | the binary itself | `[serve, ...]` |
 *
 * The compiled case is the one that needs stating. Such a binary reports
 * `argv[1]` as a path inside its virtual filesystem (`/$bunfs/root/<name>`)
 * which does not exist on disk, so the old fallback of `argv.slice(1)` handed
 * that path back to the binary as its first argument — and Commander, which
 * sees it as a subcommand name, exited with
 * `error: unknown command '/$bunfs/root/hivemind'`. The binary re-executes
 * itself, so everything before the command word must simply be dropped.
 */
export function serveWorkerArgs(argv = process.argv, cwd = process.cwd()): string[] {
  // A compiled binary IS the interpreter: `spawn(process.execPath, ...)`
  // re-runs it, so it needs the command and its flags and nothing else.
  if (isCompiledBinary(argv)) {
    return argv.slice(2);
  }

  const scriptIdx = argv.findIndex(
    (arg) => arg.endsWith("console.ts") || arg.endsWith("console.js"),
  );
  const rest = scriptIdx === -1 ? ["bin/console.ts", "serve"] : argv.slice(scriptIdx);

  // `.ts` entry points need tsx to load them; a built `.js` one does not, and
  // handing tsx a `.js` file is merely redundant rather than wrong.
  const tsxCli = rest[0]?.endsWith(".ts") === true ? resolveTsxCli(cwd) : undefined;

  if (tsxCli) {
    return [tsxCli, ...rest];
  }

  return rest;
}

/**
 * `./artisan serve` — Laravel's development HTTP server. Binds
 * `@hono/node-server` in-process (this process already booted the
 * Application). Without `--no-reload`, a supervisor parent watches
 * `.env` and respawns a worker child of the same command.
 */
export class ServeCommand extends Command {
  // Re-executes the app through a development runner and supervises `.env`
  // for live reload — a checkout-only workflow (`command.ts`/`runtime-mode.ts`
  // call this out explicitly), so a shipped binary should not offer it.
  static override devOnly = true;

  signature = "serve";
  description = "Serve the application on the Node development server.";

  configure(program: CommanderCommand): void {
    program
      .option("--host <host>", "The host address to serve the application on")
      .option("--port <port>", "The port to serve the application on")
      .option("--tries <count>", "The max number of ports to attempt to serve from", "10")
      .option("--no-reload", "Do not reload the development server on .env file changes");
  }

  async handle(options: ServeOptions = {}): Promise<void> {
    if (shouldSupervise(options)) {
      await this.supervise(resolveServeBinding(options));

      return;
    }

    const listening = await startServeWorker(this.app, options);
    this.info(`Server running on [${formatServeUrl(listening.hostname, listening.port)}].`);
    this.line("  Press Ctrl+C to stop the server");
    await waitUntilStopped(listening);

    // Closing the listener releases the HTTP server and nothing else. A
    // dev server booted against MySQL/Postgres/Redis still holds those
    // pools and sockets, and each of them keeps Node's event loop alive
    // on its own — so without this the process sits there after Ctrl+C
    // instead of exiting. `ConsoleKernel.run()` also terminates in a
    // `finally`, and `terminate()` is idempotent; the explicit call here
    // keeps `serve` correct for a caller that drives the command
    // directly.
    await this.app.terminate();
  }

  private spawnWorker(binding: ServeBinding): ChildProcess {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      [SERVE_WORKER_ENV]: "1",
      SERVER_HOST: binding.hostname,
    };

    // Pin SERVER_PORT only when the user (or SERVER_PORT itself) chose
    // the port — otherwise the worker must keep `--tries` walking.
    if (binding.portWasExplicit) {
      env.SERVER_PORT = String(binding.port);
    }

    return spawn(process.execPath, serveWorkerArgs(), {
      stdio: "inherit",
      cwd: process.cwd(),
      env,
    });
  }

  private async supervise(binding: ServeBinding): Promise<void> {
    const envFile = base_path(".env");
    let stopping = false;
    let child: ChildProcess | undefined;

    const untrap = trap(["SIGINT", "SIGTERM"], (signal) => {
      stopping = true;

      if (child && childIsRunning(child)) {
        child.kill(signal);
      }
    });

    try {
      while (!stopping) {
        child = this.spawnWorker(binding);
        const reason = await this.waitForChildOrEnvChange(child, envFile, () => stopping);

        if (reason === "env") {
          this.info("Environment modified. Restarting server...");

          if (childIsRunning(child)) {
            child.kill("SIGTERM");
          }

          await waitForExit(child);
          continue;
        }

        await waitForExit(child);

        if (stopping) {
          break;
        }

        process.exitCode = child.exitCode ?? 1;
        break;
      }
    } finally {
      untrap();
    }
  }

  private waitForChildOrEnvChange(
    child: ChildProcess,
    envFile: string,
    shouldStop: () => boolean,
  ): Promise<"exit" | "env" | "stop"> {
    const hasEnvironment = existsSync(envFile);
    let lastModified = envMtime(envFile) ?? Date.now() + 30 * 24 * 60 * 60 * 1000;

    return new Promise((resolve) => {
      const onExit = () => {
        cleanup();
        resolve("exit");
      };
      child.once("exit", onExit);

      const interval = setInterval(() => {
        if (shouldStop()) {
          cleanup();
          resolve("stop");

          return;
        }

        if (!hasEnvironment) {
          return;
        }

        const current = envMtime(envFile);

        if (current !== undefined && current > lastModified) {
          lastModified = current;
          cleanup();
          resolve("env");
        }
      }, ENV_POLL_MS);

      function cleanup() {
        child.off("exit", onExit);
        clearInterval(interval);
      }
    });
  }
}
