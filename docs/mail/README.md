# Mail

`@mahiframework/mail` is a message builder (`Mailable`), a driver resolver
(`MailManager`), and three transports. A `Mailable` describes *what* to
send and *to whom*; a transport decides *how*.

```ts
import { Mail, Mailable, Envelope, Content } from "@mahiframework/mail";

export class WelcomeMailable extends Mailable {
  constructor(private user: User) {
    super();
  }

  envelope(): Envelope {
    return new Envelope({
      subject: "Welcome to Acme",
      to: [{ address: this.user.email, name: this.user.name }],
      tags: ["welcome"],
    });
  }

  content(): Content {
    return new Content({ html: () => renderWelcome(this.user) });
  }
}

await Mail.send(new WelcomeMailable(user));
```

Note the call shape: `Mail.send(mailable)`. Recipients live on the
mailable, not on the facade. More on that [below](#the-mail-facade).

## Configuration

`config/mail.ts`:

```ts
import type { MailConfig } from "@mahiframework/mail";
import type { Env } from "./env.js";

export function mailConfig(env: Env): MailConfig {
  return {
    default: env.MAIL_MAILER,
    from: { address: env.MAIL_FROM_ADDRESS, name: env.MAIL_FROM_NAME },
    themes: {
      default: { productName: env.MAIL_FROM_NAME },
      alternative: { productName: env.MAIL_FROM_NAME, primaryColor: "#7c3aed" },
    },
    mailers: {
      log: {},
      array: {},
      smtp: {
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_PORT === 465,
        auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD ?? "" } : undefined,
        pool: true,
      },
    },
  };
}
```

```ts
interface MailConfig {
  default: string;
  mailers: Record<string, unknown>;
  from?: { address: string; name?: string };
  afterCommit?: boolean;
  themes?: Record<string, MailThemeConfig>;
}
```

`mailers` is `Record<string, unknown>` because each transport parses its
own config shape, `MailManager.mailerConfig(name)` hands the raw entry
to the factory, which casts it. A mailer with no options (`log`, `array`)
still wants an entry so it's visible in the file.

### The global `from`

`config.from` is a process-wide default sender, applied inside
`Mailable.render()` to any message whose envelope set no `from` of its
own:

```ts
return {
  from: envelope.from ?? globalFrom,
  // ...
};
```

Most apps set this once and never call `.from()` on a mailable again. A
mailable that *does* set `from()` wins. The global is a fallback, not an
override. If neither is set, `RenderedMail.from` is `undefined` and the
transport decides what that means (nodemailer will typically reject it;
the log and array transports don't care).

A generated app defaults `MAIL_MAILER` to `"log"`, so local development
and tests never open an SMTP connection by accident.

`themes` configures `MailMessage` rendering. See
[`MailMessage` and themes](#mailmessage-and-themes).

## The transports

```ts
interface MailTransport {
  send(message: RenderedMail): Promise<SentMessage>;
}
```

One method. A transport never sees a `Mailable`, only the flattened
`RenderedMail`. That boundary is what makes transports trivially testable
and mailables independent of delivery.

### `log`

Writes the rendered message through `app.logger` instead of sending it.

```ts
manager.extend("log", () => new LogTransport(app.logger));
```

```
[2026-08-27 09:14:02] local.INFO: Mail: Welcome to Acme {"from":"Example <hello@example.com>","to":"Ada Lovelace <ada@example.com>","body":"Hi Ada,\n\nWelcome."}
```

The body is logged **verbatim**, text preferred, HTML as fallback, so
what you see is a faithful preview, not a summary. `messageId` is a
synthetic `log-1`, `log-2`, ….

Right for: local development, and any environment where you want to see
what *would* have gone out without configuring a mail server. This is the
default in a new app.

Note that `LogTransport` takes `app.logger`, the always-available
`ConsoleLogger` on `Application`, not a `LOG_TOKEN` channel. That's
deliberate: it means `MailServiceProvider` has no ordering dependency on
`LoggingServiceProvider` (which is opt-in and may not be registered at
all) and can go anywhere in `providers[]`. See
[Logging](../logging/#two-separate-systems) for why those are two
different loggers.

### `array`

Captures every message in memory and sends nothing.

```ts
export class ArrayTransport implements MailTransport {
  readonly messages: RenderedMail[] = [];
  flush(): void;   // discard everything captured
}
```

Right for: tests. Point `mail.default` at `"array"`, resolve the mailer,
and assert with ordinary matchers:

```ts
const transport = manager.mailer("array") as ArrayTransport;

await manager.send(new WelcomeMailable(user));

expect(transport.messages).toHaveLength(1);
expect(transport.messages[0].subject).toBe("Welcome to Acme");
expect(transport.messages[0].to[0].address).toBe("ada@example.com");
```

This is why there are none of Laravel's ~30 `assertSentTo` /
`assertQueued` / `assertHasSubject` helpers. The captured `RenderedMail`
is a plain object; Vitest already knows how to assert on plain objects.

Remember it's a **resolved and cached** driver, the same `ArrayTransport`
instance is returned on every `mailer("array")`, so call `flush()` between
tests or build a fresh `Application`.

### `smtp`

Real delivery via [nodemailer](https://nodemailer.com), the package's one
runtime dependency.

```ts
interface SmtpTransportConfig {
  host: string;
  port?: number;
  secure?: boolean;              // true for implicit TLS (465); false for STARTTLS/plain
  auth?: { user: string; pass: string };
  pool?: boolean;                // passed through to createTransport
  requireTLS?: boolean;          // fail rather than send in the clear
  tls?: { rejectUnauthorized?: boolean; servername?: string; ciphers?: string };
}
```

> **`secure: false` does not mean "no encryption", and it does not mean
> "encryption guaranteed" either.** It means *opportunistic*: STARTTLS is
> used when the server advertises it and **silently skipped when it does
> not**. A relay that stops offering STARTTLS, misconfigured, or
> impersonated, downgrades you to plaintext with no error, and the call
> site cannot tell the difference. The promise resolves, `accepted` lists
> the recipient, and the password and body crossed the wire in the clear.
>
> Set `requireTLS: true` on any submission port (587) to make that a hard
> failure. `SMTP_REQUIRE_TLS=true` in a generated app.
>
> `tls.rejectUnauthorized` defaults to `true` and should stay there.
> Setting it to `false` disables certificate verification entirely, which
> makes the connection trivially interceptable. It exists for a
> self-signed cert on an internal relay, not for silencing a certificate
> error in production.

Call `close()` to tear down a pooled transporter. Only meaningful with
`pool: true`, where nodemailer keeps sockets open for reuse and those
sockets hold the event loop open. A short-lived process would otherwise
hang until they idle out.

The nodemailer `Transporter` is created **lazily on first `send()`**, not
in the constructor. Merely resolving the `smtp` mailer, which
`Manager.driver()` does synchronously, possibly during boot, never opens
a connection or a pool. That's the same "cheap synchronous construction,
lazy I/O" contract every driver in the framework follows.

On send it maps `RenderedMail` onto nodemailer's options, plus two header
conventions:

| `RenderedMail` field | SMTP header |
|---|---|
| `tags: ["welcome", "onboarding"]` | `X-Tag: welcome,onboarding` |
| `metadata: { userId: "42" }` | `X-Metadata-UserId: 42` |
| `headers: { ... }` | merged in first; the above win on collision |

Note the capital in `X-Metadata-UserId`: nodemailer title-cases each
dash-separated segment on the wire. Header names are case-insensitive per
RFC 5322, so this is correct, but a receiving system doing an exact-match
lookup on the lowercase form will miss it.

`SentMessage.accepted` / `rejected` are populated from nodemailer's
per-recipient response. The SMTP transport is the only built-in one that
reports genuine per-recipient outcomes. `log` and `array` treat every
recipient as accepted.

Right for: production, and for a local catch-all like Mailpit or MailHog
(`SMTP_HOST=127.0.0.1`, `SMTP_PORT=1025`, the defaults in a generated
app's env schema).

## `Mailable`

Two interchangeable styles, mirroring Laravel's modern `Mailable`.

### Declarative

Override `envelope()`, `content()`, and/or `attachments()` and return the
objects directly. This is the usual style for a named message.

```ts
export class InvoicePaidMailable extends Mailable {
  constructor(private invoice: Invoice) {
    super();
  }

  envelope(): Envelope {
    return new Envelope({
      subject: `Invoice ${this.invoice.number} paid`,
      to: [{ address: this.invoice.email }],
      replyTo: [{ address: "billing@example.com", name: "Billing" }],
      metadata: { invoiceId: this.invoice.id },
    });
  }

  content(): Content {
    return new Content({
      html: () => renderInvoiceHtml(this.invoice),
      text: () => renderInvoiceText(this.invoice),
    });
  }

  attachments(): Attachment[] {
    return [{ filename: `invoice-${this.invoice.number}.pdf`, path: this.invoice.pdfPath }];
  }
}
```

### Fluent

Override `build()` and chain the setters. Handy for ad-hoc messages
assembled imperatively.

```ts
export class ReminderMailable extends Mailable {
  constructor(private email: string, private days: number) {
    super();
  }

  build(): void {
    this.subject(`${this.days} days left on your trial`)
      .to(this.email)
      .replyTo("support@example.com", "Support")
      .tag("trial-reminder")
      .html(`<p>Your trial ends in ${this.days} days.</p>`)
      .text(`Your trial ends in ${this.days} days.`);
  }
}
```

The two styles are not exclusive but they don't compose: the fluent
setters mutate the `_envelope`/`_content` instances that the **default**
`envelope()`/`content()` return. A subclass that overrides `envelope()`
ignores everything `to()`/`subject()`/`tag()` put there.

### The fluent API

| Method | Effect |
|---|---|
| `to(address, name?)` | Append a `To` recipient. |
| `cc(address, name?)` | Append a `Cc` recipient. |
| `bcc(address, name?)` | Append a `Bcc` recipient. |
| `replyTo(address, name?)` | Append a `Reply-To`. |
| `from(address, name?)` | Set the sender (**replaces**, doesn't append). |
| `subject(text)` | Set the subject. |
| `tag(name)` | Append a tag. |
| `metadata(key, value)` | Set one metadata pair. |
| `view(render)` | HTML body from a thunk: `() => string \| Promise<string>`. |
| `html(html)` | HTML body from an already-rendered string. |
| `textView(render)` | Text body from a thunk. |
| `text(text)` | Text body from an already-rendered string. |
| `attach(file)` | Append an `Attachment`. |
| `header(key, value)` | Set one extra header (`smtp` only). |

Every one returns `this`. `to`/`cc`/`bcc`/`replyTo`/`tag`/`attach`
**append**; `from`/`subject`/`view`/`html`/`textView`/`text` **replace**.
`metadata`/`header` set one key at a time, overwriting that key.
The `metadata` key/value form sets one pair at a time, pass a whole
`metadata` record to `new Envelope({ ... })` if you have many.

### `Envelope`

```ts
class Envelope {
  from?: Address;
  to: Address[] = [];
  cc: Address[] = [];
  bcc: Address[] = [];
  replyTo: Address[] = [];
  subject = "";
  tags: string[] = [];
  metadata: Record<string, string> = {};

  constructor(options?: EnvelopeOptions);
}
```

Everything except the body and attachments. Mutable, not a frozen value
object. The fluent path needs to build it incrementally. The
immutability that matters is at the `RenderedMail` boundary handed to a
transport.

`tags` and `metadata` are pass-through: transports that understand them
use them (SMTP maps them to headers), the others just carry them along.

### `Content` and lazy body thunks

```ts
type BodyRenderer = () => string | Promise<string>;

class Content {
  html?: BodyRenderer;
  text?: BodyRenderer;
  constructor(options?: { html?: BodyRenderer | string; text?: BodyRenderer | string });
}
```

**Bodies are stored as thunks, not strings.** The constructor accepts
either, a plain string is wrapped into a constant thunk (`() => value`),
but internally there is only ever a function, and it is not invoked
until `render()`.

This matters for two reasons.

**Rendering is often async.** Reading a template file, calling out to a
template engine, fetching something the message needs. All of that is a
promise. If `Content` held a string, constructing a `Mailable` would have
to be async, and `new WelcomeMailable(user)` would become
`await WelcomeMailable.make(user)`. A thunk pushes the await to exactly
one place: `render()`, which is already async because sending is.

**The app chooses the template engine.** There is deliberately **no
Blade-style `view(name, data)` template system** in this package. No
`.blade.php` equivalent, no component library, no view resolver, no
compiled template cache, no `resources/views` convention. Laravel can
ship one because Blade is already in the framework; TypeScript has no
default answer, and picking one (JSX? a `.hbs` loader? template
literals?) would bake a decision every app would then have to fight.

A thunk is the smallest interface that accommodates all of them:

```ts
// Template literal — no dependencies at all
content() {
  return new Content({ html: () => `<p>Hi ${escapeHtml(this.user.name)}</p>` });
}

// A file on disk
content() {
  return new Content({
    html: async () => renderTemplate(await readFile("emails/welcome.html", "utf8"), this.user),
  });
}

// Whatever engine you installed
content() {
  return new Content({ html: () => engine.render("welcome", { user: this.user }) });
}
```

`Mailable.view(render)` is the fluent equivalent of the first. Note the
name: `view()` takes a **renderer function**, not a template name. It has
nothing to do with Laravel's `view($name, $data)`.

Either body may be omitted. Both omitted is legal and produces a message
with no body. The transports won't stop you.

### Attachments

```ts
interface Attachment {
  filename: string;
  content?: Buffer | Uint8Array | string;
  path?: string;
  contentType?: string;
  cid?: string;
}
```

**Exactly one of `content` or `path`.** `content` is the raw bytes (or a
UTF-8 string); `path` is a filesystem path the transport reads at send
time. Nothing validates that you supplied precisely one, supplying
neither yields an empty attachment, supplying both is up to the transport
(nodemailer prefers `content`).

`contentType` overrides the transport's MIME guess. `cid` marks the
attachment as **inline**, for embedding in HTML:

```ts
content() {
  return new Content({ html: () => `<img src="cid:logo@acme">` });
}

attachments(): Attachment[] {
  return [{ filename: "logo.png", path: "assets/logo.png", cid: "logo@acme" }];
}
```

Omit `cid` for an ordinary file attachment.

This is narrower than Laravel's `Illuminate\Mail\Attachment`, which
carries a whole strategy object for from-path / from-storage / from-data
resolution. Here an attachment is just resolved bytes-or-path plus
metadata; *how* the bytes were obtained is the caller's business:

```ts
import { Storage } from "@mahiframework/storage";

// A local disk hands you a real filesystem path — let the transport read it.
attachments(): Attachment[] {
  return [{ filename: "invoice.pdf", path: Storage.path(this.invoice.path, "local") }];
}
```

`attachments()` is **synchronous**, so if you need to pull the bytes
yourself, do it in `build()` (which may be async) and stash the result:

```ts
export class InvoiceMailable extends Mailable {
  constructor(private invoice: Invoice) {
    super();
  }

  async build(): Promise<void> {
    this.subject(`Invoice ${this.invoice.number}`)
      .to(this.invoice.email)
      .attach({
        filename: `invoice-${this.invoice.number}.pdf`,
        content: await Storage.get(this.invoice.path),
        contentType: "application/pdf",
      });
  }
}
```

See [Storage](../storage/).

### Address formatting

```ts
interface Address {
  address: string;
  name?: string;
}

formatAddress({ address, name }): string
formatAddressList(addresses: Address[]): string
```

`Address` is a plain interface, not a class. It carries no behaviour,
only data flowing from an `Envelope` into a `RenderedMail` and out to a
transport. The one piece of logic is `formatAddress()`, a free function so
transports can share it.

```ts
formatAddress({ address: "ada@example.com" })
// "ada@example.com"

formatAddress({ address: "ada@example.com", name: "Ada Lovelace" })
// "Ada Lovelace <ada@example.com>"

formatAddress({ address: "ops@example.com", name: "Example, Inc." })
// '"Example, Inc." <ops@example.com>'

formatAddress({ address: "x@example.com", name: 'He said "hi"' })
// '"He said \\"hi\\"" <x@example.com>'
```

The quoting rule: if the display name contains any of `,` `<` `>` `"` or
`@`, wrap it in double quotes and backslash-escape any embedded `"` or
`\`. Otherwise emit it bare. That's RFC 5322's requirement, an unquoted
comma in a display name would be read as a recipient separator, turning
`Example, Inc. <ops@example.com>` into two addresses, one of which is
garbage.

`formatAddressList()` comma-joins. Both are used by `LogTransport` for
its output and by `SmtpTransport` for the `From` header.

## `MailMessage` and themes

Most transactional email is a greeting, some paragraphs, one button and a
sign-off. Writing that as a hand-rolled HTML thunk every time means every
message in the app re-decides its own markup, and they drift.

`MailMessage` is a fluent builder for exactly that shape, rendered by a
swappable **theme**:

```ts
import { Mail, MailMessage } from "@mahiframework/mail";

await Mail.send(
  new MailMessage()
    .to(user.email, user.name)
    .subject("Reset your password")
    .greeting(`Hi ${user.name},`)
    .line("You are receiving this because we received a password reset request.")
    .button("Reset Password", url)
    .line("This link expires in 60 minutes.")
    .footer("If you didn't request a reset, no further action is required."),
);
```

**`MailMessage` extends `Mailable`.** It is not a parallel type. It goes
anywhere a mailable goes (`Mail.send()`, a notification's `toMail()`, a
test's `render()`) with the same `to()`/`cc()`/`subject()`/`attach()`
setters. This is one place the framework is deliberately simpler than
Laravel, where `MailMessage` and `Mailable` are unrelated classes with
overlapping APIs and only the former works inside a notification.

### Selecting a theme

```ts
new MailMessage()                    // the "default" theme
new MailMessage("alternative")       // a theme registered under that name
new MailMessage(new MyTheme())       // an ad-hoc instance, no registration
```

The string form is primary, and it is a string for consistency: this is
how every named thing in the framework is resolved: `Mail.mailer("smtp")`,
`Cache.store("redis")`, `queue.connection("redis")`.

A subclass may bake one in via `static theme`, the same class-level
metadata idiom as `Job.unique`, `Notification.type` and `Model.morphName`:

```ts
class AlertMessage extends MailMessage {
  static override theme = "alert";
}
```

A constructor argument beats `static theme`.

### Registering themes

The cheap path is config alone, any name listed under `mail.themes` gets
the built-in renderer configured with those settings:

```ts
// config/mail.ts
themes: {
  default:     { productName: "Acme" },
  alternative: { productName: "Acme", primaryColor: "#7c3aed" },
}
```

That is enough for `new MailMessage("alternative")` to render in a
different accent colour with no code. An unknown name **throws** rather
than falling back to the default theme. A silent fallback would send a
message in the wrong brand and look like it worked.

For a theme that needs real logic, register a factory from a provider:

```ts
mail.extendTheme("alternative", (settings) => new MyTheme(settings));
```

The factory receives that theme's `mail.themes.<name>` config, exactly as
a transport factory receives its mailer config. Theme registration is a
registry parallel to `extend()`, not a reuse of it: themes and transports
are orthogonal, and a message in any theme can go out through any mailer.

### Writing a theme

```ts
interface MailTheme {
  render(data: MailMessageData): RenderedBody | Promise<RenderedBody>;
}

interface RenderedBody { html: string; text: string; }
```

**A theme is an object, not a template file.** This package ships no
template engine and doesn't want one (see `Content` above), so rather than
invent a miniature one just for `MailMessage`, the extension point is an
interface. A theme can be template literals with no dependencies (that's
what `DefaultMailTheme` is), a wrapper around react-email/mjml/handlebars,
or a subclass of `DefaultMailTheme` overriding a single method:

```ts
class BrandTheme extends DefaultMailTheme {
  protected override button(label: string, url: string): string {
    return `<a class="btn" href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
  }
}
```

All three plug in identically, and the authoring API is unchanged by the
choice, changing how mail *looks* never means rewriting the code that
decides what it *says*.

`render()` receives a `MailMessageData`: a `level`, optional `greeting`
and `salutation`, a `footer` array, and an array of plain-data `blocks`
(`line`, `button`, `panel`, `table`). No HTML strings, no functions. A
theme gets a description of the message, never a half-rendered fragment.

**Escaping is the theme's job.** `MailMessageData` carries raw text,
because the correct escaping depends on which half you're producing: a
`line` needs `&amp;` in HTML and a bare `&` in text. Pre-escaping would
corrupt the plain-text body. Route every HTML interpolation through
`escapeHtml()`, message bodies routinely contain user-controlled data,
and an unescaped hole is a live XSS vector in webmail clients.

Both halves are produced in one call because a theme derives them from the
same walk, and because shipping HTML-only mail is a mistake worth making
structurally awkward. It's penalised by spam filters and unreadable in
text-only clients. The bundled theme renders each half independently
rather than tag-stripping the HTML, since the useful text form of a button
is `Label: https://url`, which stripping would discard entirely.

### Testing a `MailMessage`

Assert on the structure, not the markup:

```ts
const message = new MailMessage().line("Hi").button("Go", "https://example.com");

expect(message.data().blocks).toContainEqual({
  type: "button", label: "Go", url: "https://example.com", level: "info",
});
```

`data()` returns the accumulated IR without rendering anything, so the
test doesn't couple to whichever theme happens to be active.

## `render()` and `RenderedMail`

```ts
async render(globalFrom?: Address): Promise<RenderedMail>
```

The whole flattening step, in order:

1. `await this.build()`: the imperative hook, if the subclass has one.
2. Read `envelope()`, `content()`, `attachments()`.
3. `await` the `html` and `text` thunks, if present.
4. Apply `globalFrom` when the envelope set no `from`.
5. Return a plain `RenderedMail`.

```ts
interface RenderedMail {
  from?: Address;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  replyTo: Address[];
  subject: string;
  html?: string;
  text?: string;
  attachments: Attachment[];
  tags: string[];
  metadata: Record<string, string>;
  headers?: Record<string, string>;
}
```

This is the single value type crossing into a transport.

Only the `smtp` transport forwards `headers`; `log` and `array` carry them
on the captured message but do nothing with them.

### Ad-hoc messages

For a one-off that doesn't warrant its own class, `Message` is a concrete
`Mailable`:

```ts
import { Mail, Message } from "@mahiframework/mail";

await Mail.send(
  new Message()
    .to("ops@example.com")
    .subject("Alert")
    .text("Something broke.")
    .header("X-Priority", "1"),
);
```

`Mailable` is abstract with no abstract members, so `Message` is
`class Message extends Mailable {}` and nothing more.

You *can* still hand a `RenderedMail` straight to a transport:

```ts
await Mail.mailer("smtp").send(rendered);
```

but prefer `Message` unless you already have a `RenderedMail` in hand.
The transport path **bypasses `Mailable.validate()` entirely**, no CRLF
header-injection guard, no completeness check. It was previously the only
documented way to set a header, which meant the one route to the classic
injection sink was also the one route with no injection guard. `header()`
fixes that; the transport escape hatch remains for callers who genuinely
need it.

This is not Laravel's `Mail::raw($text, $callback)`. That exists because
Laravel's `Mailable` can't be instantiated, and its callback form
conflicts with this package's rule that recipients live on the mailable.

You can also call `render()` yourself, to assert on the output in a test,
or to inspect a message before sending it:

```ts
const rendered = await new WelcomeMailable(user).render();
expect(rendered.subject).toBe("Welcome to Acme");
expect(rendered.html).toContain(user.name);
```

`render()` is not idempotent in a meaningful sense: it re-runs `build()`
and re-invokes the body thunks every call. Render once and reuse the
result if the thunks are expensive.

### `SentMessage`

```ts
interface SentMessage {
  messageId: string;
  original: RenderedMail;
  accepted: string[];
  rejected: string[];
}
```

The result of a transport *accepting a message for delivery*, not proof
of delivery. `messageId` is transport-assigned (SMTP's `Message-ID`
header, or a synthetic `log-1`/`array-1`). `original` is the exact
`RenderedMail` handed over, retained so callers don't have to re-derive
it. `accepted`/`rejected` echo per-recipient outcomes for transports that
report them.

## `MailManager`

```ts
class MailManager extends Manager<MailTransport>
```

| Method | Returns | Notes |
|---|---|---|
| `mailer(name?)` | `MailTransport` | Alias for `driver()`. Default mailer when omitted. |
| `mailerConfig(name)` | `unknown` | The raw `mailers[name]` entry. |
| `send(mailable, options?)` | `Promise<SentMessage>` | Render, then hand to a mailer. |
| `getDefaultDriver()` | `string` | `config.default`. |
| `extend(name, factory)` | `this` | Register a transport. |

```ts
async send(mailable: Mailable, options?: { mailer?: string }): Promise<SentMessage> {
  const rendered = await mailable.render(this.config.from);
  return this.mailer(options?.mailer).send(rendered);
}
```

That's the whole entry point application code uses. The global `from` is
applied here, via `render()`, so a mailable that omits `from()` still
leaves with a sender regardless of which mailer sends it.

```ts
await mail.send(new WelcomeMailable(user));
await mail.send(new WelcomeMailable(user), { mailer: "smtp" });
```

`MailServiceProvider` registers all three built-ins via `extend()`, the
same mechanism a plugin would use to add `ses`:

```ts
this.app.singleton(MAIL_TOKEN, (app) => {
  const config = app.config.get<MailConfig>("mail");
  const manager = new MailManager(app, config);

  manager.extend("smtp", () => new SmtpTransport(manager.mailerConfig("smtp") as SmtpTransportConfig));
  manager.extend("log", () => new LogTransport(app.logger));
  manager.extend("array", () => new ArrayTransport());

  return manager;
});
```

No `boot()`: no built-in transport needs async warm-up.

### Sending after a transaction commits

A mailable sent inside a `DB.transaction()` is delivered immediately by
default. Override `afterCommit()` to return `true` (or set `afterCommit:
true` in the mail config for a process-wide default) and the send is held
until the transaction commits, and dropped if it rolls back:

```ts
class OrderShipped extends Mailable {
  override afterCommit() { return true; }
  // ...
}

await DB.transaction(async () => {
  const order = await Order.create({ ... });
  await Mail.send(new OrderShipped(order));   // sent after commit
});
```

When deferred, `send()` resolves with a placeholder `SentMessage`
(`{ deferred: true }`). The transport runs later, so `messageId`/
`accepted`/`rejected` aren't known yet. Outside a transaction it sends
immediately and returns the transport's real result. A mailable's own
`afterCommit()` beats the config default. Built on `@mahiframework/database`'s
[after-commit dispatch](../database/#after-commit-dispatch-for-events-jobs-mail--notifications).

## The `Mail` facade

```ts
class Mail extends Facade<MailManager>(() => MAIL_TOKEN)
```

| Static | Forwards to |
|---|---|
| `Mail.send(mailable, options?)` | `MailManager.send()` |
| `Mail.mailer(name?)` | `MailManager.mailer()` |

Two methods. That's the whole facade.

**There is no `Mail.to(...)`.** Laravel's
`Mail::to($user)->cc($manager)->send(new InvoicePaid($invoice))` splits
"who receives this" between the call site and the mailable, and the two
can silently disagree, a mailable with its own `to()` plus a facade
`to()` gives you a message with recipients from both, or from one,
depending on Laravel's internals.

Here recipients live in exactly one place: the mailable's `envelope()` or
its `to()` calls. The call site's job is only "send it".

```ts
// ✅ this is the shape
await Mail.send(new WelcomeMailable(user));
await Mail.send(new WelcomeMailable(user), { mailer: "smtp" });

// ❌ does not exist
await Mail.to(user.email).send(new WelcomeMailable(user));
```

If a message's recipients genuinely vary per call, pass them into the
constructor. That's what constructors are for:

```ts
export class ReportMailable extends Mailable {
  constructor(private recipients: string[], private report: Report) {
    super();
  }

  build(): void {
    this.subject("Weekly report").html(renderReport(this.report));
    for (const address of this.recipients) this.to(address);
  }
}
```

`Mail.mailer(name)` returns the raw `MailTransport`, for when you have a
`RenderedMail` already or want to poke at an `ArrayTransport` in a test.

Prefer injecting `MailManager` via `MAIL_TOKEN` where you have `app`. The
facade resolves off the *current global* app, so a test with its own
isolated `Application` should resolve the token off that instance.

## Sending mail from a queue

```ts
await Mail.queue(new WelcomeMailable(user));
await Mail.queue(new WelcomeMailable(user), { delaySeconds: 300, queue: "mail" });
```

Requires `QueueServiceProvider`; without it `queue()` throws a directive
error rather than silently sending.

### Rendering happens at dispatch, not in the worker

`queue()` renders the mailable **in the calling process** and enqueues the
resulting `RenderedMail`. Laravel instead serializes the `Mailable` and
re-renders on the worker.

Rendering at dispatch is better on three counts:

- **No second serialization mechanism.** A `RenderedMail` is already plain
  JSON. A queued `Mailable` would need a name registry and a rehydration
  path of its own, duplicating what `JobRegistry` already does for jobs.
- **Validation fires at the call site.** A missing subject is a 500 in your
  controller, not a `failed_jobs` row at 3am.
- **The message cannot drift.** Re-rendering on a worker reads rows that
  may have changed since dispatch, the source of "why did that email
  quote the old price".

The cost is payload size: the full HTML body rides in the job row, so a
50KB email is a 50KB row. For bulk sending, prefer a hand-written `Job`
carrying an id (below).

In-memory attachments (`{ content: Buffer }`) are **rejected** by
`queue()`, because `JSON.stringify` turns a Buffer into
`{"0":137,"1":80,…}`. Use `{ path }` so the worker reads the file at send
time. It must still exist then. Base64-inlining is deliberately not done
for you: a 5MB PDF would become a ~6.7MB row, on every retry.

### Never queue a message carrying a credential

A queued message sits in the `jobs` table **in plaintext**, and in
`failed_jobs` indefinitely if delivery fails. Anything in the body is
readable by anyone with database access for as long as the row lives.

So: no password-reset links, no magic links, no one-time codes, no
invitation tokens.

This is not an argument against deferring those flows. It is an argument
against queueing the *rendered message*. Queue a job that carries an id,
mints the credential inside `handle()`, and sends immediately:

```ts
export class SendResetLink extends Job {
  constructor(public readonly email: string) {
    super();
  }

  async handle(): Promise<void> {
    const result = await Auth.passwordBroker().sendResetLink(this.email);

    if (result.token !== undefined) {
      await Mail.send(new ResetPasswordMail(this.email, result.token, 60));
    }
  }
}
```

The token then exists only in the worker's memory. Note `Mail.send()`, not
`Mail.queue()`, queueing here would defeat the entire point.

The same reasoning is why the scaffolded auth controllers send
synchronously; see [Authentication](../authentication/).

### A hand-written job is still the right tool sometimes

Write one instead of using `Mail.queue()` when the payload would be large (bulk
sends), when the message must reflect data as of *delivery* rather than
dispatch, or when a credential is involved:

```ts
export class SendWelcomeEmailJob extends Job {
  constructor(public readonly userId: string) {
    super();
  }

  async handle(): Promise<void> {
    const user = await User.findOrFail(this.userId);
    await Mail.send(new WelcomeMailable(user));
  }
}
```

Carry an **id**, not the whole model. See [Queues](../queues/) for job
encoding, retries and backoff.

### `queue()` versus `afterCommit`

They solve different problems and compose. `afterCommit` holds a send
until the enclosing transaction commits (and drops it on rollback);
`queue()` moves the send out of the request entirely. A mailable can use
both.

## Sending mail from a notification

A `Notification`'s `toMail()` returns a `Mailable`, which `MailChannel`
hands straight to `MailManager.send()`. If a message can plausibly also
land in a database or a websocket, model it as a notification rather than
a bare mailable. See [Notifications](../notifications/).

## Testing

Set `mail.default` to `"array"` and assert on captured messages.

```ts
import { Application } from "@mahiframework/core";
import { MailManager, MailServiceProvider, MAIL_TOKEN, ArrayTransport } from "@mahiframework/mail";

const app = new Application();
app.config.set("mail", { default: "array", mailers: { array: {} } });
app.register(MailServiceProvider);
await app.bootstrap();

const mail = app.make<MailManager>(MAIL_TOKEN);
const transport = mail.mailer() as ArrayTransport;

await mail.send(new WelcomeMailable(user));

expect(transport.messages).toHaveLength(1);
expect(transport.messages[0]).toMatchObject({
  subject: "Welcome to Acme",
  to: [{ address: "ada@example.com", name: "Ada Lovelace" }],
});
```

For a unit test of the message itself, skip the manager entirely and call
`render()`:

```ts
const rendered = await new WelcomeMailable(user).render({ address: "hello@example.com" });
expect(rendered.from).toEqual({ address: "hello@example.com" });
```

## Gotchas

**`Mail.to()` does not exist.** Recipients go on the mailable.

**Overriding `envelope()` discards the fluent setters.** `to()`,
`subject()`, `tag()` and friends mutate the instance the *default*
`envelope()` returns. Override the method and that instance is
unreachable. Same for `content()` versus `view()`/`html()`/`text()`, and
`attachments()` versus `attach()`.

**`view()` takes a function, not a template name.** There is no template
system. `view(() => renderIt())`, never `view("emails.welcome", data)`.
`MailMessage` is the exception. It has a body system, but it's blocks
plus a theme, still not a template name.

**`MailMessage.html()`/`text()`/`view()`/`textView()` throw.** They are
inherited from `Mailable` but unreachable, because `MailMessage` overrides
`content()` to render through its theme. They throw rather than silently
no-op: a discarded body would surface as a blank email in production.
Use `line()`/`button()`/`panel()`, or send a plain `Mailable` for a
hand-written body.

**An unknown theme name throws.** `new MailMessage("typo")` fails at
render, it does not fall back to the default theme.

**Body thunks run on every `render()`.** `MailManager.send()` calls
`render()` once per send; sending the same mailable twice re-renders it.

**`build()` runs on every `render()` too.** A `build()` that appends to
`this._envelope.to` will double the recipients on a second render.

**Attachment `content` and `path` are not validated.** Supply exactly one.

**`Mail.mailer(name).send(rendered)` skips all validation.** No CRLF
guard, no completeness check. Prefer `Message` for ad-hoc sends.

**`Mail.queue()` writes the message body to the database in plaintext.**
Never queue a reset link, magic link or one-time code, queue a job that
mints the credential in `handle()` instead.

**`Mail.queue()` rejects in-memory attachments.** Use `{ path }`; the
worker reads the file at send time, so it must still exist then.

**`SentMessage` means "accepted", not "delivered".** A `messageId` from
SMTP tells you the server took it. Bounces happen later and are invisible
here.

**`ArrayTransport` is cached by the manager.** The same instance comes
back from every `mailer("array")`. Call `flush()` between tests.

**The SMTP transport connects lazily.** A bad host or bad credentials
surface on the first `send()`, not at boot. Nothing pings the server for
you.

**`config.from` is a fallback, not a default-and-override.** A mailable
with its own `from()` ignores it entirely.

## Related

- [Notifications](../notifications/): `toMail()`, the `mail` channel
- [Queues](../queues/): `Mail.queue()`, job encoding, retries and backoff
- [Storage](../storage/): reading attachment bytes off a disk
- [Logging](../logging/): where the `log` mailer writes, and why it uses `app.logger`
- [Configuration](../configuration/): `config/mail.ts`, the `MAIL_*`/`SMTP_*` env vars
- [Providers](../providers/): registering a custom transport via `extend()`
- [Testing](../testing/): the `array` mailer as the test fake
