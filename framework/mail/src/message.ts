import { Mailable } from "./mailable.js";

/**
 * A concrete, ad-hoc `Mailable`, the one-off message that doesn't warrant
 * its own class.
 *
 *   await Mail.send(
 *     new Message()
 *       .to("ops@example.com")
 *       .subject("Deploy finished")
 *       .text(`${count} migrations ran.`)
 *       .header("X-Priority", "1"),
 *   );
 *
 * `Mailable` is abstract with no abstract members, so this is `class
 * Message extends Mailable {}` and nothing more. It exists because the
 * alternative, hand-building a `RenderedMail` and handing it to
 * `Mail.mailer(name).send()`, bypasses `Mailable.validate()` entirely,
 * so it has no CRLF header-injection guard and no completeness check.
 * That transport-level escape hatch remains available for a caller that
 * genuinely has a `RenderedMail` already.
 *
 * This is NOT Laravel's `Mail::raw($text, $callback)`. That exists because
 * Laravel's `Mailable` is abstract-with-members and can't be instantiated;
 * its callback form also conflicts with this package's rule that
 * recipients live on the mailable, never at the call site.
 *
 * For a themed message (greeting, paragraphs, a button) use
 * `MailMessage` instead. This class is for bodies you render yourself.
 */
export class Message extends Mailable {}
