import { afterEach, describe, expect, it } from "vitest";
import { Application } from "../src/application.js";
import { app, clearCurrentApp, setCurrentApp } from "../src/global-app.js";

describe("global-app", () => {
  afterEach(() => {
    clearCurrentApp();
  });

  it("app() throws before any Application has bootstrapped", () => {
    expect(() => app()).toThrow(/No Application instance is currently registered/);
  });

  it("app() returns the exact instance after bootstrap() succeeds", async () => {
    const application = new Application();
    await application.bootstrap();

    expect(app()).toBe(application);
  });

  it("clearCurrentApp() resets state; app() throws again afterward", async () => {
    const application = new Application();
    await application.bootstrap();

    clearCurrentApp();

    expect(() => app()).toThrow();
  });

  it("setCurrentApp() lets a second Application replace the first (last bootstrapped wins)", async () => {
    const first = new Application();
    await first.bootstrap();

    const second = new Application();
    setCurrentApp(second);

    expect(app()).toBe(second);
  });
});
