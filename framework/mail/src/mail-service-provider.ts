import { ServiceProvider } from "@mahiframework/core";
import { MailManager, type MailConfig } from "./mail-manager.js";
import { SmtpTransport, type SmtpTransportConfig } from "./transports/smtp-transport.js";
import { LogTransport } from "./transports/log-transport.js";
import { ArrayTransport } from "./transports/array-transport.js";
import { DefaultMailTheme } from "./messages/default-mail-theme.js";
import { useThemeResolver } from "./messages/mail-message.js";
import { MAIL_TOKEN } from "./tokens.js";

export { MAIL_TOKEN };

/**
 * Registers the `MailManager` singleton with the three built-in mailers
 * ("smtp", "log", "array") pre-registered via `extend()`, the same
 * mechanism a plugin would use to add e.g. a "ses" transport later. No
 * `boot()` needed: no built-in transport needs async warm-up (the SMTP
 * transport opens its nodemailer pool lazily on first `send()`), same as
 * `CacheServiceProvider`'s infra-free stores.
 *
 * The "log" mailer writes through `app.logger`, the always-available
 * `ConsoleLogger` fallback every `Application` carries, so this provider
 * has no ordering dependency on `LoggingServiceProvider` (or any other
 * provider); it can appear anywhere in `config/app.ts`'s `providers[]`.
 */
export class MailServiceProvider extends ServiceProvider {
  register(): void {
    this.app.singleton(MAIL_TOKEN, (app) => {
      const config = app.config.require<MailConfig>("mail");
      const manager = new MailManager(app, config);

      manager.extend(
        "smtp",
        () => new SmtpTransport(manager.mailerConfig("smtp") as SmtpTransportConfig),
      );
      manager.extend("log", () => new LogTransport(app.logger));
      manager.extend("array", () => new ArrayTransport());

      manager.extendTheme("default", (settings) => new DefaultMailTheme(settings));

      return manager;
    });
  }

  /**
   * Point `MailMessage` at this app's `MailManager` for theme resolution.
   *
   * In `boot()` rather than `register()` so the resolver is a closure that
   * resolves the manager lazily on first use, binding it eagerly would
   * construct the `MailManager` singleton at registration time, defeating
   * the lazy resolution every other provider is careful to preserve.
   */
  boot(): void {
    useThemeResolver((name) => this.app.make<MailManager>(MAIL_TOKEN).theme(name));
  }

  /**
   * Drop the global theme resolver when the app shuts down, so a test that
   * builds a second `Application` doesn't inherit a resolver pointing at a
   * terminated one, the same hazard `clearCurrentApp()` exists for.
   */
  shutdown(): void {
    useThemeResolver(undefined);
  }
}
