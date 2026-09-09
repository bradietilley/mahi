import { describe, expect, it } from "vitest";
import { Application } from "@mahi/core";
import { MailManager, type QueueMailOptions } from "../src/mail-manager.js";
import { ArrayTransport } from "../src/transports/array-transport.js";
import { Mailable } from "../src/mailable.js";
import { Message } from "../src/message.js";
import { MailException } from "../src/mail-exception.js";
import type { RenderedMail } from "../src/mail-transport.js";

class WelcomeMailable extends Mailable {
  build(): void {
    this.subject("Welcome").to("ada@example.com").html("<p>Hi</p>").text("Hi");
  }
}

function buildManager(): MailManager {
  const app = new Application();
  const manager = new MailManager(app, {
    default: "array",
    mailers: { array: {} },
    from: { address: "sys@example.com" },
  });
  manager.extend("array", () => new ArrayTransport());

  return manager;
}

/** Captures what the queue would have been handed. */
function withHandler(manager: MailManager): Array<[RenderedMail, QueueMailOptions]> {
  const pushed: Array<[RenderedMail, QueueMailOptions]> = [];
  manager.useQueuedMailHandler(async (message, options) => {
    pushed.push([message, options]);
  });

  return pushed;
}

describe("MailManager.queue()", () => {
  it("throws a directive error when no queue is wired", async () => {
    const manager = buildManager();

    await expect(manager.queue(new WelcomeMailable())).rejects.toThrow(MailException);
    await expect(manager.queue(new WelcomeMailable())).rejects.toThrow(/QueueServiceProvider/);
  });

  it("renders at dispatch and hands the rendered message to the handler", async () => {
    const manager = buildManager();
    const pushed = withHandler(manager);

    await manager.queue(new WelcomeMailable());

    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.[0]).toMatchObject({
      subject: "Welcome",
      to: [{ address: "ada@example.com", name: undefined }],
      html: "<p>Hi</p>",
      text: "Hi",
      from: { address: "sys@example.com" },
    });
  });

  it("does not deliver through a transport", async () => {
    const manager = buildManager();
    withHandler(manager);

    await manager.queue(new WelcomeMailable());

    expect((manager.mailer() as ArrayTransport).messages).toHaveLength(0);
  });

  it("applies the global from, as send() does", async () => {
    const manager = buildManager();
    const pushed = withHandler(manager);

    await manager.queue(new WelcomeMailable());

    expect(pushed[0]?.[0].from).toEqual({ address: "sys@example.com" });
  });

  it("forwards queue options to the handler", async () => {
    const manager = buildManager();
    const pushed = withHandler(manager);

    await manager.queue(new WelcomeMailable(), {
      mailer: "smtp",
      delaySeconds: 60,
      connection: "redis",
      queue: "mail",
    });

    expect(pushed[0]?.[1]).toEqual({
      mailer: "smtp",
      delaySeconds: 60,
      connection: "redis",
      queue: "mail",
    });
  });

  it("validates at the CALL SITE, so a broken mailable fails here and not in a worker", async () => {
    const manager = buildManager();
    withHandler(manager);

    // No subject — the same MailException send() would raise.
    const broken = new Message().to("a@example.com").text("body");

    await expect(manager.queue(broken)).rejects.toThrow(/no subject/);
  });

  it("produces a payload that survives a JSON round-trip", async () => {
    const manager = buildManager();
    const pushed = withHandler(manager);

    await manager.queue(new WelcomeMailable());

    const original = pushed[0]![0];
    expect(JSON.parse(JSON.stringify(original))).toEqual(original);
  });
});

describe("MailManager.queue() attachment guard", () => {
  it("rejects an in-memory attachment, which JSON would mangle", async () => {
    const manager = buildManager();
    withHandler(manager);

    const message = new Message()
      .to("a@example.com")
      .subject("Report")
      .text("attached")
      .attach({ filename: "report.pdf", content: Buffer.from([1, 2, 3]) });

    await expect(manager.queue(message)).rejects.toThrow(MailException);
    await expect(manager.queue(message)).rejects.toThrow(/report\.pdf/);
    await expect(manager.queue(message)).rejects.toThrow(/does not survive JSON/);
  });

  it("allows a path attachment, which the worker reads at send time", async () => {
    const manager = buildManager();
    const pushed = withHandler(manager);

    const message = new Message()
      .to("a@example.com")
      .subject("Report")
      .text("attached")
      .attach({ filename: "report.pdf", path: "/tmp/report.pdf" });

    await manager.queue(message);

    expect(pushed[0]?.[0].attachments).toEqual([
      { filename: "report.pdf", path: "/tmp/report.pdf" },
    ]);
  });

  it("still sends an in-memory attachment immediately — the guard is queue-only", async () => {
    const manager = buildManager();

    const message = new Message()
      .to("a@example.com")
      .subject("Report")
      .text("attached")
      .attach({ filename: "report.pdf", content: Buffer.from([1, 2, 3]) });

    await expect(manager.send(message)).resolves.toBeDefined();
  });
});
