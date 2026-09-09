import { afterEach, describe, expect, it } from "vitest";
import { Application, setAfterCommitResolver, clearAfterCommitResolver } from "@mahi/core";
import { MailManager } from "../src/mail-manager.js";
import { ArrayTransport } from "../src/transports/array-transport.js";
import { Mailable } from "../src/mailable.js";

class WelcomeMailable extends Mailable {
  build(): void {
    this.subject("Welcome").to("ada@example.com").text("Hi");
  }
}

function buildManager(
  from: { address: string; name?: string } = { address: "sys@example.com" },
): MailManager {
  const app = new Application();
  const manager = new MailManager(app, { default: "array", mailers: { array: {} }, from });
  manager.extend("array", () => new ArrayTransport());

  return manager;
}

describe("MailManager", () => {
  it("mailer() resolves the default mailer when called without a name", () => {
    const manager = buildManager();
    expect(manager.mailer()).toBeInstanceOf(ArrayTransport);
  });

  it("mailer() caches the same instance across calls", () => {
    const manager = buildManager();
    expect(manager.mailer()).toBe(manager.mailer());
  });

  it("send() renders the mailable and delivers it via the default mailer", async () => {
    const manager = buildManager();
    const sent = await manager.send(new WelcomeMailable());

    const transport = manager.mailer() as ArrayTransport;
    expect(transport.messages).toHaveLength(1);
    expect(transport.messages[0]?.subject).toBe("Welcome");
    expect(sent.original.to).toEqual([{ address: "ada@example.com", name: undefined }]);
  });

  it("send() applies the config-level global from", async () => {
    const manager = buildManager({ address: "noreply@example.com", name: "App" });
    await manager.send(new WelcomeMailable());

    const transport = manager.mailer() as ArrayTransport;
    expect(transport.messages[0]?.from).toEqual({ address: "noreply@example.com", name: "App" });
  });

  it("send() honors an explicit mailer override", async () => {
    const manager = buildManager();
    const other = new ArrayTransport();
    manager.extend("other", () => other);

    await manager.send(new WelcomeMailable(), { mailer: "other" });

    expect(other.messages).toHaveLength(1);
    expect((manager.mailer("array") as ArrayTransport).messages).toHaveLength(0);
  });

  describe("after-commit sending", () => {
    afterEach(() => clearAfterCommitResolver());

    /** A fake transaction capturing deferred callbacks. */
    function fakeTransaction(): { drain: () => Promise<void> } {
      const deferred: Array<() => void | Promise<void>> = [];
      setAfterCommitResolver({ run: async (cb) => void deferred.push(cb), active: () => true });

      return {
        drain: async () => {
          for (const cb of deferred) {
            await cb();
          }
        },
      };
    }

    class AfterCommitMailable extends Mailable {
      override afterCommit() {
        return true;
      }
      override build(): void {
        this.subject("Deferred").to("ada@example.com").text("Hi");
      }
    }

    it("holds the send until the transaction commits", async () => {
      const manager = buildManager();
      const trx = fakeTransaction();

      const result = await manager.send(new AfterCommitMailable());
      const transport = manager.mailer() as ArrayTransport;

      // Nothing sent yet; the result is a deferred placeholder.
      expect(transport.messages).toHaveLength(0);
      expect(result.deferred).toBe(true);

      await trx.drain();
      expect(transport.messages).toHaveLength(1);
    });

    it("sends immediately when no transaction is open", async () => {
      const manager = buildManager();
      const result = await manager.send(new AfterCommitMailable());

      expect((manager.mailer() as ArrayTransport).messages).toHaveLength(1);
      expect(result.deferred).toBeFalsy();
    });

    it("defers when the mail config opts in, even for an unmarked mailable", async () => {
      const app = new Application();
      const manager = new MailManager(app, {
        default: "array",
        mailers: { array: {} },
        from: { address: "sys@example.com" },
        afterCommit: true,
      });
      manager.extend("array", () => new ArrayTransport());
      const trx = fakeTransaction();

      await manager.send(new WelcomeMailable());
      expect((manager.mailer() as ArrayTransport).messages).toHaveLength(0);

      await trx.drain();
      expect((manager.mailer() as ArrayTransport).messages).toHaveLength(1);
    });

    it("a mailable's afterCommit() overrides the config default", async () => {
      const app = new Application();
      const manager = new MailManager(app, {
        default: "array",
        mailers: { array: {} },
        from: { address: "sys@example.com" },
        afterCommit: true,
      });
      manager.extend("array", () => new ArrayTransport());
      fakeTransaction();

      class Immediate extends Mailable {
        override afterCommit() {
          return false;
        }
        override build(): void {
          this.subject("Now").to("ada@example.com").text("Hi");
        }
      }

      await manager.send(new Immediate());
      // Sent immediately despite config.afterCommit = true.
      expect((manager.mailer() as ArrayTransport).messages).toHaveLength(1);
    });
  });
});
