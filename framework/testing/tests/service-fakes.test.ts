import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Application, ServiceProvider, CACHE_TOKEN } from "@mahiframework/core";
import { DatabaseServiceProvider } from "@mahiframework/database";
import { EventsServiceProvider } from "@mahiframework/events";
import { Process, makeProcessResult } from "@mahiframework/process";
import {
  Mail,
  MAIL_TOKEN,
  Mailable,
  MailServiceProvider,
  type MailManager,
} from "@mahiframework/mail";
import {
  Notification,
  NOTIFICATIONS_TOKEN,
  NotificationsServiceProvider,
  type ChannelManager,
  type NotificationRoutable,
} from "@mahiframework/notifications";
import { Storage, STORAGE_TOKEN, StorageManager } from "@mahiframework/storage";
import { CacheServiceProvider, Cache, type CacheManager } from "@mahiframework/cache";
import { createTestApplication } from "../src/create-test-application.js";
import { assertDatabaseCount } from "../src/database-assertions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_MIGRATIONS_DIR = path.join(__dirname, "__fixtures__/migrations");

class WelcomeMailable extends Mailable {
  constructor(private readonly email: string) {
    super();
  }
  override build(): void {
    this.to(this.email).subject("Welcome").html("<p>Hi</p>");
  }
}

class InvoicePaid extends Notification {
  constructor(public readonly invoiceId: string) {
    super();
  }
  via(): string[] {
    return ["mail"];
  }
  override toMail(notifiable: NotificationRoutable): Mailable {
    return new WelcomeMailable(String(notifiable.routeNotificationFor("mail")));
  }
  override toDatabase(): object {
    return { invoiceId: this.invoiceId };
  }
}

class User implements NotificationRoutable {
  constructor(
    public readonly id: string,
    public readonly email: string,
  ) {}
  routeNotificationFor(channel: string): unknown {
    return channel === "mail" ? this.email : this.id;
  }
}

/** Fixture app wiring database + events + mail + notifications + cache. */
class FakesProvider extends ServiceProvider {
  migrations(): string {
    return FIXTURE_MIGRATIONS_DIR;
  }
}

async function bootstrapApp(): Promise<Application> {
  const app = new Application();
  app.config.set("database", {
    default: "sqlite",
    migrationsPath: "database/migrations",
    connections: { sqlite: { filename: process.env.DB_FILENAME } },
  });
  app.config.set("mail", { default: "array", mailers: {} });
  app.config.set("cache", {
    default: "array",
    stores: { array: { sweepIntervalSeconds: 0 } },
  });
  app.config.set("storage", {
    default: "public",
    disks: {
      public: { driver: "local", root: path.join(process.env.DB_FILENAME ?? ".", "..", "public") },
    },
  });

  app.register(DatabaseServiceProvider);
  app.register(EventsServiceProvider);
  app.register(MailServiceProvider);
  app.register(NotificationsServiceProvider);
  app.register(CacheServiceProvider);
  app.register(await import("@mahiframework/storage").then((m) => m.StorageServiceProvider));
  app.register(FakesProvider);

  await app.bootstrap();

  return app;
}

afterEach(() => {
  delete process.env.DB_FILENAME;
  delete process.env.NODE_ENV;
});

describe("fakeMail", () => {
  it("records mailables and delivers nothing when fakeMail is set", async () => {
    const testApp = await createTestApplication(bootstrapApp, { fakeMail: true });
    try {
      const manager = testApp.app.make<MailManager>(MAIL_TOKEN);
      await manager.send(new WelcomeMailable("alice@example.com"));

      expect(testApp.mail).toBeDefined();
      testApp.mail!.assertSent(WelcomeMailable);
      testApp.mail!.assertSent(
        WelcomeMailable,
        (m) => m.envelope().to[0]?.address === "alice@example.com",
      );
      testApp.mail!.assertSentTimes(WelcomeMailable, 1);
    } finally {
      await testApp.cleanup();
    }
  });

  it("is visible through the Mail facade", async () => {
    const testApp = await createTestApplication(bootstrapApp, { fakeMail: true });
    try {
      await Mail.send(new WelcomeMailable("bob@example.com"));
      testApp.mail!.assertSent(
        WelcomeMailable,
        (m) => m.envelope().to[0]?.address === "bob@example.com",
      );
    } finally {
      await testApp.cleanup();
    }
  });

  it("assertNothingSent passes when no mail was sent", async () => {
    const testApp = await createTestApplication(bootstrapApp, { fakeMail: true });
    try {
      testApp.mail!.assertNothingSent();
      expect(() => testApp.mail!.assertSent(WelcomeMailable)).toThrow(/have been sent/);
    } finally {
      await testApp.cleanup();
    }
  });

  it("records a half-built mailable that render() would reject", async () => {
    // A fake proves intent: no body, no global mail.from, render() would
    // throw a MailException, but the recorder must still accept it.
    class BareMailable extends Mailable {
      override build(): void {
        this.to("nobody@example.com");
      }
    }
    const testApp = await createTestApplication(bootstrapApp, { fakeMail: true });
    try {
      await testApp.app.make<MailManager>(MAIL_TOKEN).send(new BareMailable());
      testApp.mail!.assertSent(BareMailable);
    } finally {
      await testApp.cleanup();
    }
  });
});

describe("fakeNotifications", () => {
  it("records per-notifiable and writes no database row when faked", async () => {
    const testApp = await createTestApplication(bootstrapApp, { fakeNotifications: true });
    try {
      const alice = new User("alice", "alice@example.com");
      const bob = new User("bob", "bob@example.com");
      const manager = testApp.app.make<ChannelManager>(NOTIFICATIONS_TOKEN);
      await manager.send(alice, new InvoicePaid("inv-1"));

      expect(testApp.notifications).toBeDefined();
      testApp.notifications!.assertSentTo(alice, InvoicePaid);
      testApp.notifications!.assertSentTo(alice, InvoicePaid, (n) => n.invoiceId === "inv-1");
      testApp.notifications!.assertNotSentTo(bob, InvoicePaid);

      // Faked: no notifications table row written.
      await assertDatabaseCount(testApp.app, "widgets", 0);
    } finally {
      await testApp.cleanup();
    }
  });
});

describe("fakeStorage", () => {
  it("isolates writes to a temp dir and exposes assertExists/assertMissing", async () => {
    const testApp = await createTestApplication(bootstrapApp, { fakeStorage: ["public"] });
    try {
      const disk = testApp.app.make<StorageManager>(STORAGE_TOKEN).disk("public");
      await disk.put("avatars/1.png", "bytes");

      expect(testApp.storage.public).toBeDefined();
      await testApp.storage.public!.assertExists("avatars/1.png");
      await testApp.storage.public!.assertMissing("avatars/2.png");
      await expect(testApp.storage.public!.assertMissing("avatars/1.png")).rejects.toThrow(
        /is missing/,
      );
    } finally {
      await testApp.cleanup();
    }
  });

  it("is visible through the Storage facade", async () => {
    const testApp = await createTestApplication(bootstrapApp, { fakeStorage: true });
    try {
      await Storage.put("note.txt", "hello");
      await testApp.storage.public!.assertExists("note.txt");
    } finally {
      await testApp.cleanup();
    }
  });
});

describe("fakeCache", () => {
  it("points the default store at a fresh in-memory store", async () => {
    const testApp = await createTestApplication(bootstrapApp, { fakeCache: true });
    try {
      const store = testApp.app.make<CacheManager>(CACHE_TOKEN).store();
      await store.put("k", "v", 60);
      expect(await store.get("k")).toBe("v");

      // Facade sees the same faked store.
      expect(await Cache.get("k")).toBe("v");
    } finally {
      await testApp.cleanup();
    }
  });
});

describe("fakeProcess", () => {
  it("intercepts commands instead of spawning them, and restores on cleanup", async () => {
    const testApp = await createTestApplication(bootstrapApp, { fakeProcess: true });
    try {
      expect(Process.isFaked()).toBe(true);

      // An unmatched command is satisfied rather than spawned. The test
      // would otherwise shell out for real.
      const result = await Process.run("git rev-parse HEAD");
      expect(result.exitCode).toBe(0);
      expect(result.successful()).toBe(true);

      Process.assertRan("git *");
    } finally {
      await testApp.cleanup();
    }

    // Module-level state, so leaking it would silently fake every
    // subsequent test file.
    expect(Process.isFaked()).toBe(false);
  });

  it("leaves Process alone when not asked for", async () => {
    const testApp = await createTestApplication(bootstrapApp);
    try {
      expect(Process.isFaked()).toBe(false);
    } finally {
      await testApp.cleanup();
    }
  });

  it("lets the test stub specific commands on top", async () => {
    const testApp = await createTestApplication(bootstrapApp, { fakeProcess: true });
    try {
      Process.fake({ "git status*": makeProcessResult("git status", 0, "clean\n", "") });

      const result = await Process.run("git status --short");

      expect(result.stdout).toBe("clean\n");
    } finally {
      await testApp.cleanup();
    }
  });
});
