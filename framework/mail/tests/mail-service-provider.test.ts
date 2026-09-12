import { describe, expect, it } from "vitest";
import { Application } from "@mahiframework/core";
import { MailServiceProvider, MAIL_TOKEN } from "../src/mail-service-provider.js";
import { MailManager } from "../src/mail-manager.js";
import { ArrayTransport } from "../src/transports/array-transport.js";
import { LogTransport } from "../src/transports/log-transport.js";
import { SmtpTransport } from "../src/transports/smtp-transport.js";

function bootApp(): Application {
  const app = new Application();
  app.config.set("mail", {
    default: "array",
    mailers: {
      array: {},
      log: {},
      smtp: { host: "127.0.0.1", port: 1025 },
    },
  });
  new MailServiceProvider(app).register();

  return app;
}

describe("MailServiceProvider", () => {
  it("binds a MailManager singleton at MAIL_TOKEN", () => {
    const app = bootApp();
    const manager = app.make<MailManager>(MAIL_TOKEN);
    expect(manager).toBeInstanceOf(MailManager);
    expect(app.make<MailManager>(MAIL_TOKEN)).toBe(manager);
  });

  it("pre-registers the three built-in mailers", () => {
    const app = bootApp();
    const manager = app.make<MailManager>(MAIL_TOKEN);
    expect(manager.mailer("array")).toBeInstanceOf(ArrayTransport);
    expect(manager.mailer("log")).toBeInstanceOf(LogTransport);
    expect(manager.mailer("smtp")).toBeInstanceOf(SmtpTransport);
  });
});
