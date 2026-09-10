import { describe, expect, it } from "vitest";
import { AnonymousNotifiable } from "../src/anonymous-notifiable.js";

describe("AnonymousNotifiable", () => {
  it("returns the registered route for a channel", () => {
    const notifiable = new AnonymousNotifiable().route("mail", "ops@example.com");
    expect(notifiable.routeNotificationFor("mail")).toBe("ops@example.com");
  });

  it("returns undefined for an unregistered channel", () => {
    const notifiable = new AnonymousNotifiable();
    expect(notifiable.routeNotificationFor("mail")).toBeUndefined();
  });

  it("route() is chainable", () => {
    const notifiable = new AnonymousNotifiable()
      .route("mail", "a@example.com")
      .route("slack", "#ops");
    expect(notifiable.routeNotificationFor("mail")).toBe("a@example.com");
    expect(notifiable.routeNotificationFor("slack")).toBe("#ops");
  });

  it("rejects the database channel", () => {
    expect(() => new AnonymousNotifiable().route("database", "1")).toThrow(
      /database channel does not support anonymous/,
    );
  });
});
