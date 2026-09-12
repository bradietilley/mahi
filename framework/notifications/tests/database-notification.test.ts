import { afterEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp, setCurrentApp } from "@mahiframework/core";
import {
  DATABASE_TOKEN,
  DatabaseManager,
  MigrationRunner,
  Relation,
  SCHEMA_TOKEN,
  SqliteDriver,
} from "@mahiframework/database";
import { DatabaseChannel } from "../src/channels/database-channel.js";
import { DatabaseNotification } from "../src/database-notification.js";
import { Notification } from "../src/notification.js";
import type { NotificationRoutable } from "../src/notifiable.js";

class User implements NotificationRoutable {
  static table = "users";
  constructor(public id: string) {}
  routeNotificationFor(channel: string): unknown {
    return channel === "database" ? this.id : null;
  }
}

class FollowNotification extends Notification {
  constructor(private actorId: string) {
    super();
  }
  via(): string[] {
    return ["database"];
  }
  toDatabase(): Record<string, unknown> {
    return { actorId: this.actorId };
  }
}

async function setup() {
  const sqlite = new SqliteDriver({ filename: ":memory:" });
  const app = new Application();
  const manager = new DatabaseManager(app, { default: "sqlite", connections: { sqlite: {} } });
  manager.extend("sqlite", () => sqlite);
  app.instance(DATABASE_TOKEN, manager);
  app.bind(SCHEMA_TOKEN, () => manager.schema());
  setCurrentApp(app);

  const runner = new MigrationRunner(sqlite.kysely);
  await runner.up([new URL("../src/migrations", import.meta.url).pathname]);

  return { channel: new DatabaseChannel(manager) };
}

describe("DatabaseNotification read-model", () => {
  afterEach(() => {
    clearCurrentApp();
    Relation.resetMorphMap();
  });

  it("reads back a channel-written row with decoded payload, unread", async () => {
    const { channel } = await setup();
    await channel.send(new User("user-1"), new FollowNotification("actor-9"));

    const rows = (await DatabaseNotification.for("users", "user-1").get()).all();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.unread()).toBe(true);
    expect(row.read()).toBe(false);
    expect(row.payload()).toEqual({ actorId: "actor-9" });
  });

  it("markAsRead() stamps read_at and updated_at", async () => {
    const { channel } = await setup();
    await channel.send(new User("user-1"), new FollowNotification("actor-9"));

    const row = (await DatabaseNotification.for("users", "user-1").get()).all()[0]!;
    await row.markAsRead();

    const reloaded = (await DatabaseNotification.for("users", "user-1").get()).all()[0]!;
    expect(reloaded.read()).toBe(true);
    expect(reloaded.getRawAttribute("read_at")).not.toBeNull();
    // updated_at is stamped by the model's save() when read_at flips.
    expect(reloaded.getRawAttribute("updated_at")).not.toBeNull();
  });

  it("unreadFor() returns only unread notifications", async () => {
    const { channel } = await setup();
    await channel.send(new User("user-1"), new FollowNotification("a"));
    await channel.send(new User("user-1"), new FollowNotification("b"));

    const first = (await DatabaseNotification.for("users", "user-1").get()).all()[0]!;
    await first.markAsRead();

    const unread = (await DatabaseNotification.unreadFor("users", "user-1").get()).all();
    expect(unread).toHaveLength(1);
  });

  it("markAllAsRead() marks every unread notification read", async () => {
    const { channel } = await setup();
    await channel.send(new User("user-1"), new FollowNotification("a"));
    await channel.send(new User("user-1"), new FollowNotification("b"));

    await DatabaseNotification.markAllAsRead("users", "user-1");

    const unread = (await DatabaseNotification.unreadFor("users", "user-1").get()).all();
    expect(unread).toHaveLength(0);
  });

  it("scopes to the given recipient only", async () => {
    const { channel } = await setup();
    await channel.send(new User("user-1"), new FollowNotification("a"));
    await channel.send(new User("user-2"), new FollowNotification("b"));

    const rows = (await DatabaseNotification.for("users", "user-1").get()).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload()).toEqual({ actorId: "a" });
  });
});
