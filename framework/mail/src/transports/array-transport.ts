import type { MailTransport, RenderedMail } from "../mail-transport.js";
import type { SentMessage } from "../sent-message.js";

/**
 * In-memory transport that captures every message instead of sending it,
 * the mail analogue of `ArrayCacheStore`/`SyncQueueDriver`: correct, zero
 * infra, the ideal default for tests. Point `MAIL_MAILER=array` (or set
 * `mail.default` to `"array"`) in the test environment, resolve the mailer,
 * and assert against `transport.messages` with ordinary Vitest matchers.
 * This is the "fake mode" consumer, and the reason a TS `Mailable` needs
 * none of Laravel's ~30 `assertXxx()` helpers.
 *
 *   const transport = manager.mailer("array") as ArrayTransport;
 *   await manager.send(new WelcomeMailable(user));
 *   expect(transport.messages).toHaveLength(1);
 *   expect(transport.messages[0].subject).toBe("Welcome");
 */
export class ArrayTransport implements MailTransport {
  /** Every message handed to this transport, in send order. */
  readonly messages: RenderedMail[] = [];

  private counter = 0;

  async send(message: RenderedMail): Promise<SentMessage> {
    this.messages.push(message);

    const recipients = [...message.to, ...message.cc, ...message.bcc].map((a) => a.address);

    return {
      messageId: `array-${++this.counter}`,
      original: message,
      accepted: recipients,
      rejected: [],
    };
  }

  /** Discard all captured messages, handy between tests. */
  flush(): void {
    this.messages.length = 0;
  }
}
