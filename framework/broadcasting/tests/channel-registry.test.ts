import { describe, expect, it } from "vitest";
import { ChannelRegistry } from "../src/channel-registry.js";

describe("ChannelRegistry", () => {
  it("authorizes any public channel without a callback", async () => {
    const registry = new ChannelRegistry();
    expect(await registry.authorize("posts", null)).toEqual({ authorized: true });
    expect(await registry.authorize("posts.5", { id: "1" })).toEqual({ authorized: true });
  });

  it("fails a private channel closed when no callback is registered", async () => {
    const registry = new ChannelRegistry();
    expect(await registry.authorize("private-orders.5", { id: "1" })).toEqual({
      authorized: false,
    });
  });

  it("runs the matching callback for a private channel and passes captured params", async () => {
    const registry = new ChannelRegistry();
    const seen: unknown[] = [];
    registry.channel<{ id: string }>("orders.{orderId}", (user, orderId) => {
      seen.push([user, orderId]);

      return user?.id === orderId;
    });

    expect(await registry.authorize("private-orders.42", { id: "42" })).toEqual({
      authorized: true,
    });
    expect(await registry.authorize("private-orders.42", { id: "99" })).toEqual({
      authorized: false,
    });
    expect(seen).toEqual([
      [{ id: "42" }, "42"],
      [{ id: "99" }, "42"],
    ]);
  });

  it("matches the pattern against the prefix-stripped channel name", async () => {
    const registry = new ChannelRegistry();
    registry.channel("orders.{orderId}", () => true);

    // Same pattern authorizes both private- and presence- variants.
    expect(await registry.authorize("private-orders.1", null)).toMatchObject({ authorized: true });
  });

  it("denies a guest (null user) on a private channel whose callback checks the user", async () => {
    const registry = new ChannelRegistry();
    registry.channel<{ id: string }>("orders.{orderId}", (user) => user !== null);
    expect(await registry.authorize("private-orders.1", null)).toEqual({ authorized: false });
  });

  it("returns presence member data from a presence callback", async () => {
    const registry = new ChannelRegistry();
    registry.channel<{ id: string; name: string }>("chat.{room}", (user) =>
      user ? { id: user.id, name: user.name } : false,
    );

    expect(await registry.authorize("presence-chat.general", { id: "7", name: "Ada" })).toEqual({
      authorized: true,
      presenceData: { id: "7", name: "Ada" },
    });
    expect(await registry.authorize("presence-chat.general", null)).toEqual({ authorized: false });
  });

  it("anchors patterns so a param does not span dots", async () => {
    const registry = new ChannelRegistry();
    registry.channel("orders.{orderId}", () => true);

    // orders.{orderId} must not match orders.5.items
    expect(await registry.authorize("private-orders.5.items", null)).toEqual({ authorized: false });
  });

  it("supports wildcard segments", async () => {
    const registry = new ChannelRegistry();
    registry.channel("admin.*", () => true);
    expect(await registry.authorize("private-admin.reports", null)).toMatchObject({
      authorized: true,
    });
  });

  it("awaits async callbacks", async () => {
    const registry = new ChannelRegistry();
    registry.channel("orders.{orderId}", async (_user, orderId) => {
      await Promise.resolve();

      return orderId === "1";
    });
    expect(await registry.authorize("private-orders.1", null)).toMatchObject({ authorized: true });
    expect(await registry.authorize("private-orders.2", null)).toMatchObject({ authorized: false });
  });
});
