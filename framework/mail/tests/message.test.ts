import { describe, expect, it } from "vitest";
import { Message } from "../src/message.js";
import { MailException } from "../src/mail-exception.js";

const FROM = { address: "from@example.com" };

describe("Message", () => {
  it("is directly instantiable, with no subclass", async () => {
    const rendered = await new Message()
      .to("ops@example.com")
      .subject("Deploy finished")
      .text("3 migrations ran.")
      .render(FROM);

    expect(rendered).toMatchObject({
      to: [{ address: "ops@example.com", name: undefined }],
      subject: "Deploy finished",
      text: "3 migrations ran.",
      from: FROM,
    });
  });

  it("still enforces Mailable validation", async () => {
    await expect(new Message().subject("x").text("y").render(FROM)).rejects.toThrow(/no recipient/);
    await expect(new Message().to("a@example.com").text("y").render(FROM)).rejects.toThrow(
      /no subject/,
    );
    await expect(new Message().to("a@example.com").subject("x").render(FROM)).rejects.toThrow(
      /no content/,
    );
  });
});

describe("Mailable.header()", () => {
  it("carries headers onto the RenderedMail", async () => {
    const rendered = await new Message()
      .to("ops@example.com")
      .subject("Alert")
      .text("Something broke.")
      .header("X-Priority", "1")
      .header("X-Campaign", "ops")
      .render(FROM);

    expect(rendered.headers).toEqual({ "X-Priority": "1", "X-Campaign": "ops" });
  });

  it("defaults to an empty header map", async () => {
    const rendered = await new Message().to("a@example.com").subject("x").text("y").render(FROM);

    expect(rendered.headers).toEqual({});
  });

  it("lets a later call overwrite an earlier one", async () => {
    const rendered = await new Message()
      .to("a@example.com")
      .subject("x")
      .text("y")
      .header("X-Priority", "1")
      .header("X-Priority", "5")
      .render(FROM);

    expect(rendered.headers).toEqual({ "X-Priority": "5" });
  });

  it("rejects CRLF in a header value — the classic injection sink", async () => {
    const message = new Message()
      .to("a@example.com")
      .subject("x")
      .text("y")
      .header("X-Thing", "ok\r\nBcc: attacker@evil.test");

    await expect(message.render(FROM)).rejects.toThrow(MailException);
    await expect(message.render(FROM)).rejects.toThrow(/header value/);
  });

  it("rejects CRLF in a header name", async () => {
    const message = new Message()
      .to("a@example.com")
      .subject("x")
      .text("y")
      .header("X-Thing\r\nBcc", "attacker@evil.test");

    await expect(message.render(FROM)).rejects.toThrow(/header name/);
  });

  it("rejects a bare LF as well as a full CRLF", async () => {
    const message = new Message()
      .to("a@example.com")
      .subject("x")
      .text("y")
      .header("X-Thing", "ok\nBcc: attacker@evil.test");

    await expect(message.render(FROM)).rejects.toThrow(/header value/);
  });
});
