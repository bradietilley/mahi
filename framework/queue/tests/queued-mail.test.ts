import { afterEach, describe, expect, it } from "vitest";
import { Application, clearCurrentApp } from "@mahi/core";
import { ArrayTransport, Mailable, MailManager, MailServiceProvider, MAIL_TOKEN } from "@mahi/mail";
import { QueueServiceProvider, QUEUE_TOKEN } from "../src/queue-service-provider.js";
import { QueueManager } from "../src/queue-manager.js";
import { SendQueuedMail, QUEUED_MAIL_JOB } from "../src/jobs/send-queued-mail.js";
import { FakeQueueDriver } from "../src/drivers/fake-queue-driver.js";
import { JobRegistry } from "../src/job-registry.js";
import { JOB_REGISTRY_TOKEN } from "../src/tokens.js";

class WelcomeMailable extends Mailable {
  build(): void {
    this.subject("Welcome").to("ada@example.com").text("Hi Ada");
  }
}

/**
 * A full app with both providers, which is the only way to exercise the
 * handler `QueueServiceProvider.boot()` installs on `MailManager` — the
 * failure mode this file exists for lives entirely in that wiring.
 */
async function buildApp(connection = "sync"): Promise<Application> {
  const app = new Application();
  app.config.set("mail", {
    default: "array",
    mailers: { array: {} },
    from: { address: "sys@example.com" },
  });
  app.config.set("queue", { default: connection, connections: { sync: {}, fake: {} } });
  app.register(MailServiceProvider);
  app.register(QueueServiceProvider);
  await app.bootstrap();

  return app;
}

afterEach(() => clearCurrentApp());

describe("Mail.queue() through the queue", () => {
  it("registers the built-in mail job", async () => {
    const app = await buildApp();
    const registry = app.make<JobRegistry>(JOB_REGISTRY_TOKEN);

    expect(registry.has(QUEUED_MAIL_JOB)).toBe(true);
    expect(registry.resolve(QUEUED_MAIL_JOB)).toBe(SendQueuedMail);
  });

  it("delivers end-to-end on the sync connection", async () => {
    const app = await buildApp("sync");
    const mail = app.make<MailManager>(MAIL_TOKEN);

    await mail.queue(new WelcomeMailable());

    // `sync` runs the job inline, so by now the transport has the message.
    const transport = mail.mailer() as ArrayTransport;
    expect(transport.messages).toHaveLength(1);
    expect(transport.messages[0]).toMatchObject({
      subject: "Welcome",
      text: "Hi Ada",
      to: [{ address: "ada@example.com", name: undefined }],
      from: { address: "sys@example.com" },
    });
  });

  it("pushes a SendQueuedMail carrying the rendered message", async () => {
    const app = await buildApp("fake");
    const mail = app.make<MailManager>(MAIL_TOKEN);
    const queue = app.make<QueueManager>(QUEUE_TOKEN);
    const fake = queue.connection() as FakeQueueDriver;

    await mail.queue(new WelcomeMailable());

    fake.assertPushed(SendQueuedMail);
    expect(fake.pushed(SendQueuedMail)).toHaveLength(1);
  });

  it("survives the driver's encode/decode round-trip", async () => {
    // `SyncQueueDriver` performs the same serialization round-trip as a
    // durable driver even though it never leaves the process, so this
    // proves a `RenderedMail` is faithfully reconstructible — the property
    // the whole render-at-dispatch design rests on.
    const app = await buildApp("sync");
    const mail = app.make<MailManager>(MAIL_TOKEN);

    await mail.queue(
      new WelcomeMailable().cc("cc@example.com").tag("onboarding").header("X-Priority", "1"),
    );

    const transport = mail.mailer() as ArrayTransport;
    expect(transport.messages[0]).toMatchObject({
      cc: [{ address: "cc@example.com" }],
      tags: ["onboarding"],
      headers: { "X-Priority": "1" },
    });
  });

  it("honours the mailer option through the queue", async () => {
    const app = await buildApp("sync");
    const mail = app.make<MailManager>(MAIL_TOKEN);
    mail.extend("secondary", () => new ArrayTransport());

    await mail.queue(new WelcomeMailable(), { mailer: "secondary" });

    expect((mail.mailer("secondary") as ArrayTransport).messages).toHaveLength(1);
    expect((mail.mailer("array") as ArrayTransport).messages).toHaveLength(0);
  });

  it("forwards delay to the queue", async () => {
    const app = await buildApp("fake");
    const mail = app.make<MailManager>(MAIL_TOKEN);
    const fake = app.make<QueueManager>(QUEUE_TOKEN).connection() as FakeQueueDriver;

    await mail.queue(new WelcomeMailable(), { delaySeconds: 300 });

    expect(fake.pushed(SendQueuedMail)).toHaveLength(1);
  });

  it("unbinds the handler on shutdown, so a terminated app is not reachable", async () => {
    const app = await buildApp();
    const mail = app.make<MailManager>(MAIL_TOKEN);

    await app.terminate();

    await expect(mail.queue(new WelcomeMailable())).rejects.toThrow(/QueueServiceProvider/);
  });
});
