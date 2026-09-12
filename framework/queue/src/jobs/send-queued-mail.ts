import { app } from "@mahiframework/core";
import { MAIL_TOKEN, type MailManager, type RenderedMail } from "@mahiframework/mail";
import { Job } from "../job.js";

/**
 * Built-in job that delivers a message rendered at dispatch time.
 *
 * Dispatched by the handler `QueueServiceProvider` installs on
 * `MailManager` when `@mahiframework/mail` is registered — not intended to be
 * dispatched by application code directly; call `Mail.queue()` instead.
 *
 * The `RenderedMail` is carried as a constructor field, so it rides
 * through the same `{...job}` serialization as any other job's fields. It
 * survives intact because it is deliberately plain: strings, arrays and
 * plain objects, no class instances and no functions. (Body thunks were
 * already resolved by `render()`; in-memory attachment buffers are
 * rejected at `Mail.queue()` rather than mangled here.)
 *
 * Note the job holds a fully-formed message, which means the `jobs` row
 * contains the message BODY in plaintext — and `failed_jobs` keeps it
 * indefinitely. See `MailManager.queue()` on why a message carrying a
 * credential must not be queued this way.
 */
export class SendQueuedMail extends Job {
  constructor(
    public readonly message: RenderedMail,
    public readonly mailer?: string,
  ) {
    super();
  }

  async handle(): Promise<void> {
    const mail = app().make<MailManager>(MAIL_TOKEN);

    await mail.mailer(this.mailer).send(this.message);
  }
}

export const QUEUED_MAIL_JOB = "mail.send-queued-mail";
