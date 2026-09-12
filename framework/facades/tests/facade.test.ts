import { afterEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp } from "@mahiframework/core";
import { Facade } from "../src/facade.js";

class Greeter {
  constructor(private name: string) {}
  greet(): string {
    return `hello, ${this.name}`;
  }
}

class Greeting extends Facade<Greeter>(() => "greeter") {
  static greet(): string {
    return this.instance().greet();
  }
}

describe("Facade", () => {
  afterEach(() => {
    clearCurrentApp();
  });

  it("throws when no Application has bootstrapped yet, same as app()", () => {
    expect(() => Greeting.greet()).toThrow(/No Application instance is currently registered/);
  });

  it("resolves the token off the current app() once bootstrapped, via instance()", async () => {
    const application = new Application();
    application.singleton("greeter", () => new Greeter("world"));
    await application.bootstrap();

    expect(Greeting.greet()).toBe("hello, world");
    expect(Greeting.instance()).toBeInstanceOf(Greeter);
  });

  it("re-resolves on every call, so a later setCurrentApp() swap is picked up", async () => {
    const first = new Application();
    first.singleton("greeter", () => new Greeter("first"));
    await first.bootstrap();

    expect(Greeting.greet()).toBe("hello, first");

    const second = new Application();
    second.singleton("greeter", () => new Greeter("second"));
    await second.bootstrap();

    expect(Greeting.greet()).toBe("hello, second");
  });

  it("throws the container's own BindingNotFoundError when the token was never bound", async () => {
    const application = new Application();
    await application.bootstrap();

    class Missing extends Facade<Greeter>(() => "missing-token") {
      static greet(): string {
        return this.instance().greet();
      }
    }

    expect(() => Missing.greet()).toThrow(
      /Nothing bound in the container for token "missing-token"/,
    );
  });
});

describe("Facade.swap()", () => {
  afterEach(() => {
    Greeting.restore();
    clearCurrentApp();
  });

  it("intercepts instance() without touching the container", async () => {
    const application = new Application();
    application.singleton("greeter", () => new Greeter("world"));
    await application.bootstrap();

    Greeting.swap({ greet: () => "hello, fake" });

    expect(Greeting.greet()).toBe("hello, fake");
    // The container still holds the real one — a swap changes what THIS
    // facade returns, not what everything resolving the token gets.
    expect(application.make<Greeter>("greeter").greet()).toBe("hello, world");
  });

  it("restores the container-resolved instance", async () => {
    const application = new Application();
    application.singleton("greeter", () => new Greeter("world"));
    await application.bootstrap();

    Greeting.swap({ greet: () => "hello, fake" });
    expect(Greeting.greet()).toBe("hello, fake");

    Greeting.restore();
    expect(Greeting.greet()).toBe("hello, world");
  });

  it("works before any Application exists", async () => {
    // A swap should not require a bootstrapped app: the whole point is to
    // avoid resolving. Without this, a unit test would have to build an
    // Application just to then bypass it.
    expect(() => Greeting.greet()).toThrow(/No Application instance/);

    Greeting.swap({ greet: () => "hello, standalone" });

    expect(Greeting.greet()).toBe("hello, standalone");
  });

  it("reports whether a swap is in effect", () => {
    expect(Greeting.isSwapped()).toBe(false);

    Greeting.swap({ greet: () => "x" });
    expect(Greeting.isSwapped()).toBe(true);

    Greeting.restore();
    expect(Greeting.isSwapped()).toBe(false);
  });

  it("returns the double so it can be captured inline", () => {
    const calls: string[] = [];
    const fake = Greeting.swap({
      greet: () => {
        calls.push("greet");

        return "recorded";
      },
    });

    expect(Greeting.greet()).toBe("recorded");
    expect(calls).toEqual(["greet"]);
    expect(typeof fake.greet).toBe("function");
  });

  it("keeps each facade's swap to itself", async () => {
    // Each `Facade<T>()` call produces its own class, so two facades must
    // not share swap state — otherwise faking Cache would silently fake
    // Queue too.
    class Other extends Facade<Greeter>(() => "greeter") {
      static greet(): string {
        return this.instance().greet();
      }
    }

    const application = new Application();
    application.singleton("greeter", () => new Greeter("world"));
    await application.bootstrap();

    Greeting.swap({ greet: () => "only me" });

    expect(Greeting.greet()).toBe("only me");
    expect(Other.greet()).toBe("hello, world");
    expect(Other.isSwapped()).toBe(false);
  });

  it("isolates siblings that share one Facade() base class", () => {
    // Subtler than the case above: these two share the SAME base, so
    // isolation rests on `this.swapped = ...` creating an own property on
    // the subclass rather than mutating the base. If it wrote through to
    // the base, swapping one would swap every facade built from it.
    const Base = Facade<Greeter>(() => "greeter");
    class First extends Base {}
    class Second extends Base {}

    First.swap({ greet: () => "first" });

    expect(First.isSwapped()).toBe(true);
    expect(Second.isSwapped()).toBe(false);
  });

  it("throws a normal TypeError for a method the double omits", () => {
    // A partial double is the common case. Calling something it does not
    // define should fail loudly rather than return undefined.
    Greeting.swap({});

    expect(() => Greeting.greet()).toThrow(TypeError);
  });
});
