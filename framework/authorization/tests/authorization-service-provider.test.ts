import { afterEach, describe, expect, it } from "vitest";
import { Application, ServiceProvider, clearCurrentApp } from "@mahiframework/core";
import { GateRegistry } from "../src/gate.js";
import { Policy } from "../src/policy.js";
import { AuthorizationServiceProvider, GATE_TOKEN } from "../src/authorization-service-provider.js";

class Widget {}

class WidgetPolicy extends Policy {
  view(): boolean {
    return true;
  }
}

const order: string[] = [];

class FirstProvider extends ServiceProvider {
  gates(gate: GateRegistry): void {
    order.push("first");
    gate.define("first-ability", () => true);
  }
}

class SecondProvider extends ServiceProvider {
  gates(gate: GateRegistry): void {
    order.push("second");
    gate.policy(Widget, WidgetPolicy);
  }
}

/** No gates() hook at all — must not break collection. */
class SilentProvider extends ServiceProvider {}

describe("AuthorizationServiceProvider", () => {
  afterEach(() => {
    order.length = 0;
    clearCurrentApp();
  });

  async function boot(): Promise<Application> {
    const app = new Application();
    app.register(AuthorizationServiceProvider);
    app.register(FirstProvider);
    app.register(SilentProvider);
    app.register(SecondProvider);
    await app.bootstrap();

    return app;
  }

  it("binds a GateRegistry singleton", async () => {
    const app = await boot();

    const gate = app.make<GateRegistry>(GATE_TOKEN);
    expect(gate).toBeInstanceOf(GateRegistry);
    expect(app.make(GATE_TOKEN)).toBe(gate);
  });

  it("collects gates() from every provider, in registration order", async () => {
    const app = await boot();
    const gate = app.make<GateRegistry>(GATE_TOKEN);

    expect(order).toEqual(["first", "second"]);
    expect(gate.has("first-ability")).toBe(true);
    expect(gate.hasPolicy(Widget)).toBe(true);
  });

  it("tolerates providers with no gates() hook", async () => {
    await expect(boot()).resolves.toBeInstanceOf(Application);
  });
});
