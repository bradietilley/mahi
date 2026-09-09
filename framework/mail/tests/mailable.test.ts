import { describe, expect, it } from "vitest";
import { Mailable } from "../src/mailable.js";
import { Envelope } from "../src/mailables/envelope.js";
import { Content } from "../src/mailables/content.js";

class FluentMailable extends Mailable {
  constructor(private email: string) {
    super();
  }

  build(): void {
    this.subject("Welcome").to(this.email, "Ada").cc("cc@example.com").html("<p>Hi</p>").text("Hi");
  }
}

class DeclarativeMailable extends Mailable {
  constructor(private email: string) {
    super();
  }

  envelope(): Envelope {
    return new Envelope({
      subject: "Declared",
      to: [{ address: this.email, name: "Grace" }],
      tags: ["welcome"],
    });
  }

  content(): Content {
    return new Content({ html: () => `<p>Hello ${this.email}</p>`, text: "plain" });
  }
}

class AsyncViewMailable extends Mailable {
  build(): void {
    this.subject("Async")
      .to("a@example.com")
      .view(async () => {
        await Promise.resolve();

        return "<p>rendered</p>";
      });
  }
}

const GLOBAL_FROM = { address: "sys@example.com", name: "Sys" };

describe("Mailable (fluent build)", () => {
  it("renders envelope + content set through fluent setters", async () => {
    const rendered = await new FluentMailable("ada@example.com").render(GLOBAL_FROM);

    expect(rendered.subject).toBe("Welcome");
    expect(rendered.to).toEqual([{ address: "ada@example.com", name: "Ada" }]);
    expect(rendered.cc).toEqual([{ address: "cc@example.com", name: undefined }]);
    expect(rendered.html).toBe("<p>Hi</p>");
    expect(rendered.text).toBe("Hi");
  });

  it("awaits an async view() renderer", async () => {
    const rendered = await new AsyncViewMailable().render(GLOBAL_FROM);
    expect(rendered.html).toBe("<p>rendered</p>");
  });
});

describe("Mailable (declarative overrides)", () => {
  it("uses overridden envelope() and content()", async () => {
    const rendered = await new DeclarativeMailable("grace@example.com").render(GLOBAL_FROM);

    expect(rendered.subject).toBe("Declared");
    expect(rendered.to).toEqual([{ address: "grace@example.com", name: "Grace" }]);
    expect(rendered.tags).toEqual(["welcome"]);
    expect(rendered.html).toBe("<p>Hello grace@example.com</p>");
    expect(rendered.text).toBe("plain");
  });
});

describe("Mailable global from", () => {
  it("applies globalFrom only when no from() was set", async () => {
    const rendered = await new FluentMailable("ada@example.com").render({
      address: "sys@example.com",
      name: "Sys",
    });
    expect(rendered.from).toEqual({ address: "sys@example.com", name: "Sys" });
  });

  it("prefers an explicit from() over globalFrom", async () => {
    class WithFrom extends Mailable {
      build(): void {
        this.subject("Hi").from("me@example.com").to("x@example.com").text("body");
      }
    }
    const rendered = await new WithFrom().render({ address: "sys@example.com" });
    expect(rendered.from).toEqual({ address: "me@example.com", name: undefined });
  });
});
