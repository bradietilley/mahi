import { afterEach, describe, expect, it } from "vitest";
import { MailMessage, useThemeResolver } from "../src/messages/mail-message.js";
import { DefaultMailTheme } from "../src/messages/default-mail-theme.js";
import { MailException } from "../src/mail-exception.js";
import type { MailMessageData } from "../src/messages/blocks.js";
import type { MailTheme, RenderedBody } from "../src/messages/mail-theme.js";

/** Records what it was handed, so tests can assert on the IR, not on markup. */
class SpyTheme implements MailTheme {
  received: MailMessageData | undefined;

  render(data: MailMessageData): RenderedBody {
    this.received = data;

    return { html: "<p>spy</p>", text: "spy" };
  }
}

afterEach(() => {
  useThemeResolver(undefined);
});

describe("MailMessage block accumulation", () => {
  it("records blocks in call order", () => {
    const message = new MailMessage(new SpyTheme())
      .line("first")
      .button("Go", "https://example.com")
      .panel("quoted")
      .line("last");

    expect(message.data().blocks).toEqual([
      { type: "line", text: "first" },
      { type: "button", label: "Go", url: "https://example.com", level: "info" },
      { type: "panel", text: "quoted" },
      { type: "line", text: "last" },
    ]);
  });

  it("defaults a button's level to the message level", () => {
    const message = new MailMessage(new SpyTheme()).error().button("Revoke", "https://example.com");

    expect(message.data().blocks[0]).toMatchObject({ type: "button", level: "error" });
  });

  it("lets a button override the message level", () => {
    const message = new MailMessage(new SpyTheme())
      .error()
      .button("Ok", "https://example.com", "success");

    expect(message.data().blocks[0]).toMatchObject({ level: "success" });
  });

  it("returns a defensive copy of the blocks", () => {
    const message = new MailMessage(new SpyTheme()).line("one");
    message.data().blocks.push({ type: "line", text: "injected" });

    expect(message.data().blocks).toHaveLength(1);
  });
});

describe("MailMessage theme selection", () => {
  it("uses an explicitly passed theme instance without any resolver", async () => {
    const theme = new SpyTheme();
    const message = new MailMessage(theme).to("a@example.com").subject("Hi").line("body");

    const rendered = await message.render({ address: "from@example.com" });

    expect(rendered.html).toBe("<p>spy</p>");
    expect(theme.received?.blocks).toEqual([{ type: "line", text: "body" }]);
  });

  it("resolves a named theme through the bound resolver", async () => {
    const alternative = new SpyTheme();
    useThemeResolver((name) => {
      expect(name).toBe("alternative");

      return alternative;
    });

    const message = new MailMessage("alternative").to("a@example.com").subject("Hi").line("body");
    await message.render({ address: "from@example.com" });

    expect(alternative.received).toBeDefined();
  });

  it('asks for "default" when given no theme', async () => {
    const seen: string[] = [];
    useThemeResolver((name) => {
      seen.push(name);

      return new SpyTheme();
    });

    await new MailMessage().to("a@example.com").subject("Hi").line("x").render({
      address: "from@example.com",
    });

    expect(seen).toEqual(["default"]);
  });

  it("honours a subclass's static theme", async () => {
    const seen: string[] = [];
    useThemeResolver((name) => {
      seen.push(name);

      return new SpyTheme();
    });

    class AlertMessage extends MailMessage {
      static override theme = "alert";
    }

    await new AlertMessage().to("a@example.com").subject("Hi").line("x").render({
      address: "from@example.com",
    });

    expect(seen).toEqual(["alert"]);
  });

  it("lets a constructor argument beat the subclass's static theme", async () => {
    const seen: string[] = [];
    useThemeResolver((name) => {
      seen.push(name);

      return new SpyTheme();
    });

    class AlertMessage extends MailMessage {
      static override theme = "alert";
    }

    await new AlertMessage("override").to("a@example.com").subject("Hi").line("x").render({
      address: "from@example.com",
    });

    expect(seen).toEqual(["override"]);
  });

  it("throws a directive error when no resolver is bound", () => {
    expect(() => new MailMessage().line("x").theme()).toThrow(MailException);
    expect(() => new MailMessage().line("x").theme()).toThrow(/No mail theme resolver is bound/);
  });
});

describe("MailMessage body-setter guards", () => {
  it.each(["html", "text", "view", "textView"] as const)(
    "throws rather than silently discarding %s()",
    (method) => {
      const message = new MailMessage(new SpyTheme());

      expect(() => (message[method] as () => never)()).toThrow(MailException);
      expect(() => (message[method] as () => never)()).toThrow(/would be discarded/);
    },
  );
});

describe("MailMessage is a Mailable", () => {
  it("renders through the normal Mailable pipeline, validation included", async () => {
    const message = new MailMessage(new SpyTheme()).subject("Hi").line("body");

    await expect(message.render({ address: "from@example.com" })).rejects.toThrow(/no recipient/);
  });

  it("carries envelope fields set by the inherited fluent setters", async () => {
    const rendered = await new MailMessage(new SpyTheme())
      .to("ada@example.com", "Ada")
      .cc("cc@example.com")
      .replyTo("reply@example.com")
      .subject("Welcome")
      .tag("onboarding")
      .line("body")
      .render({ address: "from@example.com" });

    expect(rendered).toMatchObject({
      to: [{ address: "ada@example.com", name: "Ada" }],
      cc: [{ address: "cc@example.com", name: undefined }],
      replyTo: [{ address: "reply@example.com", name: undefined }],
      subject: "Welcome",
      tags: ["onboarding"],
      from: { address: "from@example.com" },
    });
  });

  it("produces both an html and a text body", async () => {
    const rendered = await new MailMessage(new DefaultMailTheme())
      .to("ada@example.com")
      .subject("Welcome")
      .line("Thanks for signing up.")
      .render({ address: "from@example.com" });

    expect(rendered.html).toContain("Thanks for signing up.");
    expect(rendered.text).toContain("Thanks for signing up.");
    expect(rendered.text).not.toContain("<p");
  });
});
