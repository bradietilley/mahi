import { describe, expect, it } from "vitest";
import { Model } from "../src/model.js";
import { ModelRegistry } from "../src/model-registry.js";

class Widget extends Model<{ id: string }>()({
  table: "widgets",
  primaryKey: "id",
  morphName: "Widget",
}) {}

class Gadget extends Model<{ id: string }>()({
  table: "gadgets",
  primaryKey: "id",
  morphName: "Gadget",
}) {}

class Unnamed extends Model<{ id: string }>()({
  table: "unnamed",
  primaryKey: "id",
}) {}

describe("ModelRegistry", () => {
  it("registers a model under its morphName and resolves it back", () => {
    const registry = new ModelRegistry();
    registry.register(Widget);

    expect(registry.has("Widget")).toBe(true);
    expect(registry.resolve("Widget")).toBe(Widget);
  });

  it("throws when registering a model that has no morphName", () => {
    const registry = new ModelRegistry();
    expect(() => registry.register(Unnamed)).toThrow(/no static morphName/);
  });

  it("throws when two different classes claim the same morphName", () => {
    const registry = new ModelRegistry();
    registry.register(Widget);

    class Impostor extends Model<{ id: string }>()({
      table: "impostors",
      primaryKey: "id",
      morphName: "Widget",
    }) {}

    expect(() => registry.register(Impostor)).toThrow(/already registered/);
  });

  it("registering the same class twice is a harmless no-op", () => {
    const registry = new ModelRegistry();
    registry.register(Widget);
    expect(() => registry.register(Widget)).not.toThrow();
    expect(registry.resolve("Widget")).toBe(Widget);
  });

  it("resolve() throws for an unknown morphName", () => {
    const registry = new ModelRegistry();
    expect(() => registry.resolve("Nope")).toThrow(/not registered/);
  });

  it("nameFor() returns the morphName of an instance's class, or undefined", () => {
    const registry = new ModelRegistry();
    const widget = Widget.hydrate({ id: "1" });
    const unnamed = Unnamed.hydrate({ id: "1" });
    const gadget = Gadget.hydrate({ id: "1" });

    expect(registry.nameFor(widget)).toBe("Widget");
    expect(registry.nameFor(unnamed)).toBeUndefined();
    expect(registry.nameFor(gadget)).toBe("Gadget");
  });
});
