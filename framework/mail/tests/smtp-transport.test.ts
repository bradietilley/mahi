import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { SMTPServer, type SMTPServerAuthentication, type SMTPServerSession } from "smtp-server";
import { SmtpTransport } from "../src/transports/smtp-transport.js";
import type { RenderedMail } from "../src/mail-transport.js";

/**
 * `SmtpTransport` against a real SMTP server.
 *
 * The only transport with no coverage, and the only one whose failures are
 * invisible from the outside: an `ArrayTransport` test proves a message was
 * *assembled*, but nothing proved the assembled message survives a real
 * SMTP conversation — that auth is offered and accepted, that STARTTLS is
 * negotiated before credentials go out, that attachments and headers arrive
 * intact on the wire.
 *
 * `smtp-server` is nodemailer's own server counterpart, so this exercises
 * the actual protocol rather than a hand-rolled socket mock. It listens on
 * port 0 (the OS picks a free one) so the suite never collides with a real
 * MTA or with a parallel test file.
 *
 * TLS uses a throwaway certificate minted per run rather than
 * smtp-server's bundled pair, which is hard-coded with a fixed expiry and
 * has already lapsed — using it fails with "certificate has expired"
 * regardless of `rejectUnauthorized`, and would have made this suite start
 * failing on a date nobody chose. The client passes
 * `rejectUnauthorized: false` because the cert is self-signed: correct for
 * a test, and exactly what must never appear in application config.
 */
describe("SmtpTransport", () => {
  let server: SMTPServer | undefined;
  let transport: SmtpTransport | undefined;
  let tlsKey: string;
  let tlsCert: string;
  let certDir: string;

  beforeAll(() => {
    // `openssl` rather than a JS library: it is present on macOS, on every
    // mainstream CI image, and in the node:* docker images, and this keeps
    // a crypto dependency out of the package for the sake of one test file.
    certDir = mkdtempSync(path.join(tmpdir(), "mahi-smtp-tls-"));
    const keyPath = path.join(certDir, "key.pem");
    const certPath = path.join(certDir, "cert.pem");

    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-days",
        "1",
        "-nodes",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    );

    tlsKey = readFileSync(keyPath, "utf8");
    tlsCert = readFileSync(certPath, "utf8");
  });

  afterAll(() => {
    if (certDir) {
      rmSync(certDir, { recursive: true, force: true });
    }
  });

  /** What the server observed, for assertions after a send. */
  interface Capture {
    raw: string[];
    auth: Array<{ method: string; username: string; secureAtAuth: boolean }>;
    secureAtData: boolean[];
    rejected: number;
  }

  function startServer(
    options: {
      requireAuth?: boolean;
      /** Remove the STARTTLS verb entirely — a plaintext-only relay. */
      noTls?: boolean;
      credentials?: { user: string; pass: string };
      rejectData?: boolean;
      rejectRecipient?: string;
    } = {},
  ): Promise<{ port: number; capture: Capture }> {
    const capture: Capture = { raw: [], auth: [], secureAtData: [], rejected: 0 };
    const credentials = options.credentials ?? { user: "user", pass: "pass" };

    server = new SMTPServer({
      authOptional: !options.requireAuth,
      ...(options.noTls ? { disabledCommands: ["STARTTLS" as const] } : {}),
      key: tlsKey,
      cert: tlsCert,
      logger: false,
      onAuth(
        auth: SMTPServerAuthentication,
        session: SMTPServerSession,
        callback: (err: Error | null, response?: { user: string }) => void,
      ) {
        capture.auth.push({
          method: auth.method,
          username: auth.username ?? "",
          secureAtAuth: Boolean(session.secure),
        });

        if (auth.username === credentials.user && auth.password === credentials.pass) {
          callback(null, { user: auth.username });

          return;
        }

        callback(new Error("Invalid username or password"));
      },
      onRcptTo(
        address: { address: string },
        _session: SMTPServerSession,
        callback: (err?: Error | null) => void,
      ) {
        if (options.rejectRecipient && address.address === options.rejectRecipient) {
          capture.rejected++;
          callback(new Error("550 Mailbox unavailable"));

          return;
        }

        callback();
      },
      onData(
        stream: NodeJS.ReadableStream,
        session: SMTPServerSession,
        callback: (err?: Error | null) => void,
      ) {
        let raw = "";
        stream.on("data", (chunk: Buffer | string) => {
          raw += chunk.toString();
        });
        stream.on("end", () => {
          capture.raw.push(raw);
          capture.secureAtData.push(Boolean(session.secure));

          if (options.rejectData) {
            callback(new Error("451 Temporary failure"));

            return;
          }

          callback();
        });
      },
    });

    return new Promise((resolve) => {
      server!.listen(0, "127.0.0.1", () => {
        const address = server!.server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        resolve({ port, capture });
      });
    });
  }

  /** A minimal valid `RenderedMail`, overridable per test. */
  function makeMail(overrides: Partial<RenderedMail> = {}): RenderedMail {
    return {
      from: { address: "sender@example.com", name: "Sender" },
      to: [{ address: "rcpt@example.com", name: "Recipient" }],
      cc: [],
      bcc: [],
      replyTo: [],
      subject: "Subject line",
      text: "Plain body",
      attachments: [],
      tags: [],
      metadata: {},
      ...overrides,
    };
  }

  afterEach(async () => {
    // The pool holds the event loop open; vitest would hang without this.
    transport?.close?.();
    transport = undefined;

    if (server) {
      const closing = server;
      server = undefined;
      await new Promise<void>((resolve) => closing.close(() => resolve()));
    }
  });

  describe("auth", () => {
    it("authenticates with the configured credentials", async () => {
      const { port, capture } = await startServer({ requireAuth: true });
      transport = new SmtpTransport({
        host: "127.0.0.1",
        port,
        secure: false,
        auth: { user: "user", pass: "pass" },
        tls: { rejectUnauthorized: false },
      });

      const sent = await transport.send(makeMail());

      expect(capture.auth).toHaveLength(1);
      expect(capture.auth[0]?.username).toBe("user");
      expect(sent.accepted).toEqual(["rcpt@example.com"]);
      expect(sent.messageId).toBeTruthy();
    });

    it("rejects a send with wrong credentials rather than failing silently", async () => {
      const { port } = await startServer({ requireAuth: true });
      transport = new SmtpTransport({
        host: "127.0.0.1",
        port,
        secure: false,
        auth: { user: "user", pass: "wrong" },
        tls: { rejectUnauthorized: false },
      });

      await expect(transport.send(makeMail())).rejects.toThrow(/invalid|535|credentials/i);
    });

    it("sends without auth when the server does not require it", async () => {
      const { port, capture } = await startServer({ requireAuth: false });
      transport = new SmtpTransport({
        host: "127.0.0.1",
        port,
        secure: false,
        tls: { rejectUnauthorized: false },
      });

      const sent = await transport.send(makeMail());

      expect(capture.auth).toHaveLength(0);
      expect(sent.accepted).toEqual(["rcpt@example.com"]);
    });
  });

  describe("STARTTLS", () => {
    it("upgrades the connection BEFORE sending credentials", async () => {
      // The security property that matters. If nodemailer authenticated
      // first and upgraded afterwards, the password would cross the wire
      // in plaintext — and every assertion in the auth block above would
      // still pass. `session.secure` at the moment of AUTH is the only
      // thing that distinguishes the two.
      const { port, capture } = await startServer({ requireAuth: true });
      transport = new SmtpTransport({
        host: "127.0.0.1",
        port,
        secure: false,
        auth: { user: "user", pass: "pass" },
        tls: { rejectUnauthorized: false },
      });

      await transport.send(makeMail());

      expect(capture.auth[0]?.secureAtAuth).toBe(true);
      expect(capture.secureAtData[0]).toBe(true);
    });

    it("refuses to downgrade to plaintext when requireTLS is set", async () => {
      // The opposite of the test below, and the reason the option exists.
      // Opportunistic STARTTLS silently accepts a plaintext session when
      // the server does not offer an upgrade, which is indistinguishable
      // from success at the call site — the mail sends, and the password
      // crossed the wire in the clear. `requireTLS` turns that into an
      // error.
      const { port, capture } = await startServer({ requireAuth: false, noTls: true });
      transport = new SmtpTransport({
        host: "127.0.0.1",
        port,
        secure: false,
        requireTLS: true,
        tls: { rejectUnauthorized: false },
      });

      await expect(transport.send(makeMail())).rejects.toThrow(/STARTTLS/i);
      // Nothing reached the server: it failed before DATA, not after.
      expect(capture.raw).toHaveLength(0);
    });

    it("sends over TLS when requireTLS is set and the server offers it", async () => {
      const { port, capture } = await startServer({ requireAuth: false });
      transport = new SmtpTransport({
        host: "127.0.0.1",
        port,
        secure: false,
        requireTLS: true,
        tls: { rejectUnauthorized: false },
      });

      const sent = await transport.send(makeMail());

      expect(sent.accepted).toEqual(["rcpt@example.com"]);
      expect(capture.secureAtData[0]).toBe(true);
    });

    it("rejects a self-signed certificate by default", async () => {
      // `rejectUnauthorized` defaults to true, so the opt-out the rest of
      // this file uses is genuinely an opt-out rather than the default.
      // Without it, an intercepted connection would be accepted silently.
      const { port } = await startServer({ requireAuth: false });
      transport = new SmtpTransport({
        host: "127.0.0.1",
        port,
        secure: false,
        requireTLS: true,
      });

      await expect(transport.send(makeMail())).rejects.toThrow(/self.signed|certificate/i);
    });

    it("still delivers when the server does not offer STARTTLS", async () => {
      // A plaintext-only server (an internal relay, a dev MailHog). The
      // transport must not hard-require an upgrade that was never offered.
      const { port, capture } = await startServer({ requireAuth: false, noTls: true });
      transport = new SmtpTransport({ host: "127.0.0.1", port, secure: false });

      const sent = await transport.send(makeMail());

      expect(sent.accepted).toEqual(["rcpt@example.com"]);
      // Delivered, but in the clear — which is precisely why `requireTLS`
      // exists. The call site cannot tell this apart from an encrypted
      // send: same resolved promise, same `accepted` list.
      expect(capture.secureAtData[0]).toBe(false);
      expect(capture.raw[0]).toContain("Plain body");
    });
  });

  describe("the message on the wire", () => {
    it("carries the envelope, subject and body", async () => {
      const { port, capture } = await startServer();
      transport = new SmtpTransport({
        host: "127.0.0.1",
        port,
        secure: false,
        tls: { rejectUnauthorized: false },
      });

      await transport.send(
        makeMail({
          subject: "Welcome aboard",
          text: "Plain text body",
          html: "<p>HTML body</p>",
        }),
      );

      const raw = capture.raw[0] ?? "";
      expect(raw).toContain("Subject: Welcome aboard");
      expect(raw).toContain("Sender");
      expect(raw).toContain("sender@example.com");
      expect(raw).toContain("rcpt@example.com");
      // Both bodies present, so a client that cannot render HTML still has
      // something to show.
      expect(raw).toContain("Plain text body");
      expect(raw).toContain("HTML body");
      expect(raw.toLowerCase()).toContain("multipart/alternative");
    });

    it("sends cc and replyTo, and keeps bcc out of the headers", async () => {
      // bcc must reach the server as an envelope recipient but must NOT
      // appear in the message headers, or it is not blind.
      const { port, capture } = await startServer();
      transport = new SmtpTransport({
        host: "127.0.0.1",
        port,
        secure: false,
        tls: { rejectUnauthorized: false },
      });

      const sent = await transport.send(
        makeMail({
          cc: [{ address: "cc@example.com" }],
          bcc: [{ address: "bcc@example.com" }],
          replyTo: [{ address: "reply@example.com" }],
        }),
      );

      const raw = capture.raw[0] ?? "";
      expect(raw).toContain("cc@example.com");
      expect(raw).toContain("reply@example.com");
      expect(raw).not.toContain("bcc@example.com");
      // ...but the server was still told to deliver there.
      expect(sent.accepted).toContain("bcc@example.com");
    });

    it("maps tags and metadata onto X- headers", async () => {
      const { port, capture } = await startServer();
      transport = new SmtpTransport({
        host: "127.0.0.1",
        port,
        secure: false,
        tls: { rejectUnauthorized: false },
      });

      await transport.send(
        makeMail({
          tags: ["welcome", "onboarding"],
          metadata: { campaign: "spring", cohort: "42" },
          headers: { "X-Custom": "kept" },
        }),
      );

      const raw = capture.raw[0] ?? "";
      expect(raw).toContain("X-Tag: welcome,onboarding");
      expect(raw).toContain("X-Custom: kept");
      // Note the capitals: nodemailer title-cases each dash-separated
      // segment, so the metadata key `campaign` is transmitted as
      // `X-Metadata-Campaign`. Header names are case-insensitive per
      // RFC 5322 so this is correct, but a receiving system doing an
      // exact-match lookup on the lowercase form will silently miss it.
      expect(raw).toContain("X-Metadata-Campaign: spring");
      expect(raw).toContain("X-Metadata-Cohort: 42");
    });

    it("delivers an attachment's bytes intact", async () => {
      const { port, capture } = await startServer();
      transport = new SmtpTransport({
        host: "127.0.0.1",
        port,
        secure: false,
        tls: { rejectUnauthorized: false },
      });

      await transport.send(
        makeMail({
          attachments: [
            {
              filename: "notes.txt",
              content: Buffer.from("attachment contents"),
              contentType: "text/plain",
            },
          ],
        }),
      );

      const raw = capture.raw[0] ?? "";
      expect(raw).toContain("notes.txt");
      // Base64 of "attachment contents" — the bytes survived the encode.
      expect(raw).toContain(Buffer.from("attachment contents").toString("base64"));
    });
  });

  describe("failures", () => {
    it("reports a rejected recipient without losing the accepted ones", async () => {
      const { port } = await startServer({ rejectRecipient: "bad@example.com" });
      transport = new SmtpTransport({
        host: "127.0.0.1",
        port,
        secure: false,
        tls: { rejectUnauthorized: false },
      });

      const sent = await transport.send(
        makeMail({
          to: [{ address: "rcpt@example.com" }, { address: "bad@example.com" }],
        }),
      );

      expect(sent.accepted).toEqual(["rcpt@example.com"]);
      expect(sent.rejected).toEqual(["bad@example.com"]);
    });

    it("rejects when the server refuses the message body", async () => {
      const { port } = await startServer({ rejectData: true });
      transport = new SmtpTransport({
        host: "127.0.0.1",
        port,
        secure: false,
        tls: { rejectUnauthorized: false },
      });

      await expect(transport.send(makeMail())).rejects.toThrow(/451|temporary/i);
    });

    it("rejects when nothing is listening", async () => {
      // Port 1 on loopback: reserved, and nothing can bind it unprivileged.
      transport = new SmtpTransport({ host: "127.0.0.1", port: 1, secure: false });

      await expect(transport.send(makeMail())).rejects.toThrow(/ECONNREFUSED|connect/i);
    });
  });

  describe("connection lifecycle", () => {
    it("opens no connection until the first send", async () => {
      // The laziness the class docstring promises: resolving the `smtp`
      // mailer through `MailManager` must not open a socket or a pool.
      const { port, capture } = await startServer();
      let connections = 0;
      server!.on("connect", () => {
        connections++;
      });

      transport = new SmtpTransport({
        host: "127.0.0.1",
        port,
        secure: false,
        tls: { rejectUnauthorized: false },
      });

      expect(connections).toBe(0);

      await transport.send(makeMail());

      expect(connections).toBe(1);
      expect(capture.raw).toHaveLength(1);
    });

    it("reuses a pooled transport across sends", async () => {
      const { port, capture } = await startServer({ requireAuth: true });
      transport = new SmtpTransport({
        host: "127.0.0.1",
        port,
        secure: false,
        pool: true,
        auth: { user: "user", pass: "pass" },
        tls: { rejectUnauthorized: false },
      });

      await transport.send(makeMail({ subject: "First" }));
      await transport.send(makeMail({ subject: "Second" }));

      expect(capture.raw).toHaveLength(2);
      // One connection, so one authentication — the point of pooling.
      expect(capture.auth).toHaveLength(1);
    });
  });
});
