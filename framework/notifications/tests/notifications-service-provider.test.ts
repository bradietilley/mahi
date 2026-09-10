import { describe, expect, it } from "vitest";
import { Application } from "@mahi/core";
import { DatabaseManager, DATABASE_TOKEN, SqliteDriver } from "@mahi/database";
import { EventDispatcher, EVENTS_TOKEN } from "@mahi/events";
import { MailManager, MAIL_TOKEN, ArrayTransport } from "@mahi/mail";
import {
  NotificationsServiceProvider,
  NOTIFICATIONS_TOKEN,
} from "../src/notifications-service-provider.js";
import { ChannelManager } from "../src/channel-manager.js";
import { MailChannel } from "../src/channels/mail-channel.js";
import { DatabaseChannel } from "../src/channels/database-channel.js";
import { BroadcastChannel } from "../src/channels/broadcast-channel.js";

function bindDatabase(app: Application): void {
  app.singleton(DATABASE_TOKEN, (a) => {
    const manager = new DatabaseManager(a, { default: "sqlite", connections: { sqlite: {} } });
    manager.extend("sqlite", () => new SqliteDriver({ filename: ":memory:" }));

    return manager;
  });
}

function bindMail(app: Application): void {
  app.singleton(MAIL_TOKEN, (a) => {
    const manager = new MailManager(a, { default: "array", mailers: { array: {} } });
    manager.extend("array", () => new ArrayTransport());

    return manager;
  });
}

function bindEvents(app: Application): void {
  app.singleton(EVENTS_TOKEN, (a) => new EventDispatcher(a));
}

describe("NotificationsServiceProvider", () => {
  it("binds a ChannelManager singleton at NOTIFICATIONS_TOKEN", () => {
    const app = new Application();
    bindDatabase(app);
    new NotificationsServiceProvider(app).register();

    const manager = app.make<ChannelManager>(NOTIFICATIONS_TOKEN);
    expect(manager).toBeInstanceOf(ChannelManager);
    expect(app.make<ChannelManager>(NOTIFICATIONS_TOKEN)).toBe(manager);
  });

  it("always registers the database channel", () => {
    const app = new Application();
    bindDatabase(app);
    new NotificationsServiceProvider(app).register();

    const manager = app.make<ChannelManager>(NOTIFICATIONS_TOKEN);
    expect(manager.driver("database")).toBeInstanceOf(DatabaseChannel);
  });

  it("registers the mail channel only when MAIL_TOKEN is bound", () => {
    const app = new Application();
    bindDatabase(app);
    bindMail(app);
    new NotificationsServiceProvider(app).register();

    const manager = app.make<ChannelManager>(NOTIFICATIONS_TOKEN);
    expect(manager.driver("mail")).toBeInstanceOf(MailChannel);
  });

  it("omits the mail channel when MAIL_TOKEN is absent", () => {
    const app = new Application();
    bindDatabase(app);
    new NotificationsServiceProvider(app).register();

    const manager = app.make<ChannelManager>(NOTIFICATIONS_TOKEN);
    expect(() => manager.driver("mail")).toThrow();
  });

  it("registers the broadcast channel only when EVENTS_TOKEN is bound", () => {
    const app = new Application();
    bindDatabase(app);
    bindEvents(app);
    new NotificationsServiceProvider(app).register();

    const manager = app.make<ChannelManager>(NOTIFICATIONS_TOKEN);
    expect(manager.driver("broadcast")).toBeInstanceOf(BroadcastChannel);
  });

  it("omits the broadcast channel when EVENTS_TOKEN is absent", () => {
    const app = new Application();
    bindDatabase(app);
    new NotificationsServiceProvider(app).register();

    const manager = app.make<ChannelManager>(NOTIFICATIONS_TOKEN);
    expect(() => manager.driver("broadcast")).toThrow();
  });

  it("contributes its migrations as static sources", () => {
    const app = new Application();
    const sources = new NotificationsServiceProvider(app).migrationSources();
    expect(sources.length).toBeGreaterThan(0);
    expect(sources[0]).toHaveProperty("name");
    expect(sources[0]).toHaveProperty("migration");
  });
});
