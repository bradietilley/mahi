import { describe, expect, it } from "vitest";
import { Mailable } from "../src/mailable.js";
import { MailException } from "../src/mail-exception.js";
import { Envelope } from "../src/mailables/envelope.js";
import { Content } from "../src/mailables/content.js";

class Base extends Mailable {
  build(): void {
    this.subject("Hi").from("sys@example.com").to("ada@example.com").text("body");
  }
}

const FROM = { address: "sys@example.com" };

describe("Mailable.render() validation", () => {
  it("throws when there is no recipient", async () => {
    class NoTo extends Mailable {
      build(): void {
        this.subject("Hi").from("sys@example.com").text("body");
      }
    }
    await expect(new NoTo().render()).rejects.toThrow(MailException);
    await expect(new NoTo().render()).rejects.toThrow(/no recipient/);
  });

  it("throws when there is no sender (no from and no global from)", async () => {
    class NoFrom extends Mailable {
      build(): void {
        this.subject("Hi").to("ada@example.com").text("body");
      }
    }
    await expect(new NoFrom().render()).rejects.toThrow(/no sender/);
  });

  it("accepts a message whose sender comes from the global from", async () => {
    class NoFrom extends Mailable {
      build(): void {
        this.subject("Hi").to("ada@example.com").text("body");
      }
    }
    const rendered = await new NoFrom().render(FROM);
    expect(rendered.from).toEqual(FROM);
  });

  it("throws when there is no subject", async () => {
    class NoSubject extends Mailable {
      build(): void {
        this.from("sys@example.com").to("ada@example.com").text("body");
      }
    }
    await expect(new NoSubject().render()).rejects.toThrow(/no subject/);
  });

  it("throws when there is no body and no attachment", async () => {
    class NoBody extends Mailable {
      build(): void {
        this.subject("Hi").from("sys@example.com").to("ada@example.com");
      }
    }
    await expect(new NoBody().render()).rejects.toThrow(/no content/);
  });

  it("accepts an attachment-only message with no body", async () => {
    class AttachOnly extends Mailable {
      build(): void {
        this.subject("Hi")
          .from("sys@example.com")
          .to("ada@example.com")
          .attach({ filename: "a.txt", content: "x" });
      }
    }
    const rendered = await new AttachOnly().render();
    expect(rendered.attachments).toHaveLength(1);
  });
});

describe("Mailable.render() header-injection guard", () => {
  it("rejects CRLF in a recipient address", async () => {
    class Evil extends Mailable {
      build(): void {
        this.subject("Hi").from("sys@example.com").to("a@b.c\r\nBcc: x@y.z").text("body");
      }
    }
    await expect(new Evil().render()).rejects.toThrow(/header-injection/);
  });

  it("rejects a bare LF in a display name", async () => {
    class Evil extends Mailable {
      build(): void {
        this.subject("Hi").from("sys@example.com").to("a@b.c", "Ada\nInjected").text("body");
      }
    }
    await expect(new Evil().render()).rejects.toThrow(/header-injection/);
  });

  it("rejects CRLF in the subject", async () => {
    class Evil extends Mailable {
      envelope(): Envelope {
        return new Envelope({
          subject: "Hi\r\nBcc: x@y.z",
          to: [{ address: "a@b.c" }],
          from: FROM,
        });
      }
      content(): Content {
        return new Content({ text: "body" });
      }
    }
    await expect(new Evil().render()).rejects.toThrow(/header-injection/);
  });

  it("rejects CRLF in a metadata key", async () => {
    class Evil extends Mailable {
      build(): void {
        this.subject("Hi")
          .from("sys@example.com")
          .to("a@b.c")
          .text("body")
          .metadata("k\r\nX-Evil", "v");
      }
    }
    await expect(new Evil().render()).rejects.toThrow(/header-injection/);
  });

  it("rejects CRLF in a metadata value", async () => {
    class Evil extends Mailable {
      build(): void {
        this.subject("Hi")
          .from("sys@example.com")
          .to("a@b.c")
          .text("body")
          .metadata("k", "v\r\nX-Evil: 1");
      }
    }
    await expect(new Evil().render()).rejects.toThrow(/header-injection/);
  });

  it("rejects CRLF in a tag", async () => {
    class Evil extends Mailable {
      build(): void {
        this.subject("Hi").from("sys@example.com").to("a@b.c").text("body").tag("ok\r\nX-Evil: 1");
      }
    }
    await expect(new Evil().render()).rejects.toThrow(/header-injection/);
  });

  it("passes a clean message through", async () => {
    const rendered = await new Base().render();
    expect(rendered.subject).toBe("Hi");
    expect(rendered.to).toEqual([{ address: "ada@example.com", name: undefined }]);
  });
});
