import { afterEach, describe, expect, it } from "vitest";
import { Application } from "../src/application.js";
import { clearCurrentApp, setCurrentApp } from "../src/global-app.js";
import { Context } from "../src/context-facade.js";

describe("Context facade", () => {
  afterEach(() => {
    clearCurrentApp();
  });

  it("throws when no Application has bootstrapped yet, same as app()", () => {
    expect(() => Context.add("key", "value")).toThrow(
      /No Application instance is currently registered/,
    );
  });

  it("instance() resolves the current app's context repository", () => {
    const app = new Application();
    setCurrentApp(app);

    expect(Context.instance()).toBe(app.context);
  });

  it("delegates reads and writes to app().context", () => {
    const app = new Application();
    setCurrentApp(app);

    Context.add("deploy", "abc123");
    Context.add({ region: "syd", worker: 3 });
    Context.addIf("deploy", "overwritten?");
    Context.push("breadcrumbs", "one", "two");

    expect(Context.get("deploy")).toBe("abc123");
    expect(Context.has("region")).toBe(true);
    expect(Context.missing("nope")).toBe(true);
    expect(Context.only(["deploy", "worker"])).toEqual({ deploy: "abc123", worker: 3 });
    expect(Context.except(["breadcrumbs"])).toEqual({ deploy: "abc123", region: "syd", worker: 3 });
    expect(app.context.get("breadcrumbs")).toEqual(["one", "two"]);

    expect(Context.pull("worker")).toBe(3);
    expect(Context.has("worker")).toBe(false);

    expect(Context.remember("computed", () => 42)).toBe(42);

    Context.forget(["breadcrumbs", "computed"]);
    Context.scope(
      () => {
        expect(Context.get("scoped")).toBe(true);
      },
      { scoped: true },
    );
    expect(Context.missing("scoped")).toBe(true);

    Context.flush();
    expect(Context.isEmpty()).toBe(true);
  });

  it("resolves off the *current* app — swapping apps swaps the repository", () => {
    const first = new Application();
    setCurrentApp(first);
    Context.add("app", "first");

    const second = new Application();
    setCurrentApp(second);

    expect(Context.missing("app")).toBe(true);
    expect(first.context.get("app")).toBe("first");
  });
});
