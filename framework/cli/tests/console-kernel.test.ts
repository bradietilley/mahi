import { Application, ServiceProvider, clearCurrentApp } from "@mahiframework/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "../src/command.js";
import { ConsoleKernel } from "../src/console-kernel.js";

afterEach(() => {
  clearCurrentApp();
});

describe("ConsoleKernel", () => {
  it("registers a command and runs its handle() when invoked via argv", async () => {
    const calls: string[] = [];

    class GreetCommand extends Command {
      signature = "greet";
      description = "Say hello";
      handle() {
        calls.push("greet");
      }
    }

    const app = new Application();
    const kernel = new ConsoleKernel(app);
    kernel.addCommand(GreetCommand);

    await kernel.run(["node", "console", "greet"]);

    expect(calls).toEqual(["greet"]);
  });

  it("passes positional arguments through to handle()", async () => {
    const received: string[] = [];

    class SayCommand extends Command {
      signature = "say <word>";
      description = "Say a word";
      handle(word: string) {
        received.push(word);
      }
    }

    const app = new Application();
    const kernel = new ConsoleKernel(app);
    kernel.addCommand(SayCommand);

    await kernel.run(["node", "console", "say", "hello"]);

    expect(received).toEqual(["hello"]);
  });

  it("collectFromProviders() picks up commands() contributed by every provider", async () => {
    const calls: string[] = [];

    class FromProviderCommand extends Command {
      signature = "from-provider";
      description = "Contributed by a provider";
      handle() {
        calls.push("from-provider");
      }
    }

    class MyProvider {
      commands() {
        return [FromProviderCommand];
      }
    }

    const app = new Application();
    // Simulate what Application.bootstrap() does: providers are available
    // via getProviders(). We register directly for this focused unit test.
    (app as any).providers = [new MyProvider()];

    const kernel = new ConsoleKernel(app);
    kernel.collectFromProviders();

    await kernel.run(["node", "console", "from-provider"]);

    expect(calls).toEqual(["from-provider"]);
  });

  /**
   * The program name appears in `Usage:` and in Commander's "unknown command"
   * errors, the text a confused user retypes. Hardcoding it meant a shipped
   * binary called itself `console` whatever the user had named it.
   */
  it("names itself after the executable unless told otherwise", async () => {
    const app = new Application();

    // Derived from the argv being parsed, NOT from this process's argv, which
    // in a test is the test runner's.
    const derived = new ConsoleKernel(app);
    expect(derived.helpText(["bun", "/$bunfs/root/hivemind"])).toContain("Usage: hivemind");

    // An explicit name wins over derivation, for apps whose wrapper script is
    // named differently from their entry point.
    const explicit = new ConsoleKernel(app, { name: "myapp" });
    expect(explicit.helpText(["bun", "/$bunfs/root/hivemind"])).toContain("Usage: myapp");
  });

  /**
   * `make:*` writes TypeScript into the app's source tree, and `test` shells
   * out to the app's own vitest. Offered from a shipped binary they appear in
   * `--help` and then fail on files the user has no reason to expect, so user
   * mode drops them entirely rather than hiding them.
   */
  it("drops devOnly commands in user mode and keeps them in dev mode", () => {
    class ScaffoldCommand extends Command {
      static override devOnly = true;
      signature = "make:thing";
      description = "Scaffold a thing";
      handle() {}
    }

    class RealCommand extends Command {
      signature = "migrate";
      description = "Migrate";
      handle() {}
    }

    const app = new Application();

    const dev = new ConsoleKernel(app, { mode: "dev" });
    dev.addCommand(ScaffoldCommand);
    dev.addCommand(RealCommand);
    expect(dev.registeredCommands()).toEqual([ScaffoldCommand, RealCommand]);

    const user = new ConsoleKernel(app, { mode: "user" });
    user.addCommand(ScaffoldCommand);
    user.addCommand(RealCommand);
    expect(user.registeredCommands()).toEqual([RealCommand]);
  });

  /**
   * Commander throws on a duplicate name, and it throws during `build()`,
   * so before this, an application that named a command `serve` did not lose
   * that command, it failed to boot AT ALL, `--help` included.
   *
   * The framework cannot know which names an application needs. It keeps its
   * own surface namespaced (`route:list`, `queue:work`, `maintenance:down`)
   * so a clash is unlikely, but the bare names it does ship, `serve`,
   * `migrate`, `test`, are ordinary enough that an app may want them, and
   * reserving those would let the framework dictate an app's interface.
   */
  it("lets a later command replace an earlier one of the same name", () => {
    class FrameworkServe extends Command {
      signature = "serve";
      description = "Start the development server";
      handle() {}
    }

    class AppServe extends Command {
      signature = "serve <target>";
      description = "Serve a target";
      handle() {}
    }

    const kernel = new ConsoleKernel(new Application());

    // Framework providers are collected first, so the app's registration is
    // the later one.
    kernel.addCommand(FrameworkServe);
    kernel.addCommand(AppServe);

    expect(kernel.registeredCommands()).toEqual([AppServe]);
  });

  /** The override must not disturb anything else's registration or order. */
  it("keeps every other command, in order, when one is replaced", () => {
    class Migrate extends Command {
      signature = "migrate";
      description = "Migrate";
      handle() {}
    }
    class FrameworkTest extends Command {
      signature = "test [args...]";
      description = "Run the test suite";
      handle() {}
    }
    class AppTest extends Command {
      signature = "test [reference]";
      description = "Test a task";
      handle() {}
    }
    class Serve extends Command {
      signature = "serve";
      description = "Serve";
      handle() {}
    }

    const kernel = new ConsoleKernel(new Application());
    kernel.addCommand(Migrate);
    kernel.addCommand(FrameworkTest);
    kernel.addCommand(Serve);
    kernel.addCommand(AppTest);

    // The replacement keeps the ORIGINAL position, so `--help` ordering does
    // not jump around depending on which commands an app overrides.
    expect(kernel.registeredCommands()).toEqual([Migrate, AppTest, Serve]);
  });

  /**
   * A dropped command must not merely be absent from `--help`; typing it has
   * to fail as an unknown command, or the filtering is cosmetic.
   */
  it("does not run a devOnly command in user mode", async () => {
    const calls: string[] = [];

    class ScaffoldCommand extends Command {
      static override devOnly = true;
      signature = "make:thing";
      description = "Scaffold a thing";
      handle() {
        calls.push("ran");
      }
    }

    class RealCommand extends Command {
      signature = "migrate";
      description = "Migrate";
      handle() {
        calls.push("migrate");
      }
    }

    const app = new Application();
    const kernel = new ConsoleKernel(app, { mode: "user" });
    kernel.addCommand(ScaffoldCommand);
    // A second, non-devOnly command so the program has subcommands at all,
    // otherwise Commander treats the argument as a stray operand rather than
    // an unknown command, and the test would pass for the wrong reason.
    kernel.addCommand(RealCommand);
    kernel.exitOverride();

    await expect(kernel.run(["bun", "hivemind", "make:thing"])).rejects.toThrow(/unknown command/);
    expect(calls).toEqual([]);
  });

  it("registers a `list` command that prints the command list", async () => {
    class GreetCommand extends Command {
      signature = "greet";
      description = "Say hello";
      handle() {}
    }

    const app = new Application();
    const kernel = new ConsoleKernel(app);
    kernel.addCommand(GreetCommand);

    expect(kernel.helpText(["node", "console"])).toContain("list");
  });

  it("exposes --version when a version is configured", async () => {
    const app = new Application();
    const kernel = new ConsoleKernel(app, { version: "1.2.3" }).exitOverride();

    // Commander throws a control-flow "error" carrying the version output.
    await expect(kernel.run(["node", "console", "--version"])).rejects.toMatchObject({
      message: "1.2.3",
    });
  });

  it("prints help and exits 0 for a bare invocation (no command)", async () => {
    const logs: string[] = [];
    const app = new Application();
    const kernel = new ConsoleKernel(app);

    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
      logs.push(String(chunk));

      return true;
    });
    process.exitCode = undefined;

    await kernel.run(["node", "console"]);

    spy.mockRestore();
    expect(logs.join("")).toContain("Usage:");
    expect(process.exitCode).toBeUndefined();
  });

  it("constructs each command with the Application, so commands can pull their own deps", async () => {
    let receivedApp: Application | undefined;

    class InspectCommand extends Command {
      signature = "inspect";
      description = "Inspect";
      constructor(app: Application) {
        super(app);
        receivedApp = app;
      }
      handle() {}
    }

    const app = new Application();
    const kernel = new ConsoleKernel(app);
    kernel.addCommand(InspectCommand);

    await kernel.run(["node", "console", "inspect"]);

    expect(receivedApp).toBe(app);
  });
});

/**
 * The failure this prevents is not command-specific: any pool or socket a
 * provider opened keeps Node's event loop alive, so a CLI command that
 * finishes its work and returns leaves the process running with nothing
 * to do. Measured before this: `migrate` against MySQL never exited.
 */
describe("ConsoleKernel.run() termination", () => {
  class NoopCommand extends Command {
    signature = "noop";
    description = "Does nothing";
    handle() {}
  }

  class FailingCommand extends Command {
    signature = "fail";
    description = "Throws";
    handle() {
      throw new Error("boom");
    }
  }

  it("terminates the application after a command succeeds", async () => {
    const app = new Application();
    const kernel = new ConsoleKernel(app);
    kernel.addCommand(NoopCommand);

    await kernel.run(["node", "console", "noop"]);

    expect(app.isTerminated()).toBe(true);
  });

  it("terminates even when the command throws, and still propagates the error", async () => {
    const app = new Application();
    const kernel = new ConsoleKernel(app);
    kernel.addCommand(FailingCommand);

    await expect(kernel.run(["node", "console", "fail"])).rejects.toThrow("boom");

    expect(app.isTerminated()).toBe(true);
  });

  it("terminates on a Commander parse error too", async () => {
    const app = new Application();
    const kernel = new ConsoleKernel(app).exitOverride();
    kernel.addCommand(NoopCommand);

    await expect(kernel.run(["node", "console", "does-not-exist"])).rejects.toThrow();

    expect(app.isTerminated()).toBe(true);
  });

  /**
   * The escape hatch for an embedder running several commands against one
   * long-lived Application (a REPL, an in-process harness), where tearing
   * the app down after the first would break the second.
   */
  it("leaves the application alone when terminate: false", async () => {
    const app = new Application();
    const kernel = new ConsoleKernel(app, { terminate: false });
    kernel.addCommand(NoopCommand);

    await kernel.run(["node", "console", "noop"]);

    expect(app.isTerminated()).toBe(false);
  });

  it("runs providers' shutdown() hooks", async () => {
    const events: string[] = [];

    class Connecting extends ServiceProvider {
      shutdown() {
        events.push("shutdown");
      }
    }

    const app = new Application();
    app.register(Connecting);
    await app.bootstrap();

    const kernel = new ConsoleKernel(app);
    kernel.addCommand(NoopCommand);
    await kernel.run(["node", "console", "noop"]);

    expect(events).toEqual(["shutdown"]);
  });
});
