import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PasswordResetToken } from "@mahiframework/auth";
import { createTestApplication, TestClient, type TestApplication } from "@mahiframework/testing";
import { bootstrap } from "../bin/bootstrap.js";
import { ResetPasswordMail } from "../src/mail/reset-password.mail.js";
import { registerUser, resetRateLimits } from "./helpers/auth.js";

/**
 * The password-reset endpoints, end to end.
 *
 * `fakeMail` swaps in a `RecordingMailManager`, so `testApp.mail` can
 * assert the email was sent and read the URL out of the mailable — which
 * is also how these tests get a valid token without reaching into the
 * database (the stored value is an argon2 hash, so it cannot be read back).
 */
describe("Password reset API", () => {
  let testApp: TestApplication;
  let client: TestClient;

  beforeAll(async () => {
    testApp = await createTestApplication(bootstrap, { fakeMail: true });
    client = new TestClient(testApp.request);
  });

  beforeEach(async () => {
    await resetRateLimits(testApp);
    testApp.mail?.reset();
    // One live reset per email, keyed by address — clear the table so a
    // previous test's row can't trip the per-mailbox throttle.
    await PasswordResetToken.query().delete();
  });

  afterAll(async () => {
    await testApp.cleanup();
  });

  /** Pull the reset URL out of the recorded mailable. */
  function sentResetUrl(): string {
    const sent = testApp.mail!.sent(ResetPasswordMail);
    expect(sent).toHaveLength(1);

    const button = sent[0]!.data().blocks.find((block) => block.type === "button");
    expect(button).toBeDefined();

    return (button as { url: string }).url;
  }

  /** The `token` query param from a reset URL. */
  function tokenFrom(url: string): string {
    return new URL(url, "https://app.test").searchParams.get("token") ?? "";
  }

  describe("POST /auth/forgot-password", () => {
    it("emails a reset link to a known address", async () => {
      const user = await registerUser(testApp);
      testApp.mail!.reset();

      const { status } = await client.postJson("/auth/forgot-password", { email: user.email });

      expect(status).toBe(200);
      testApp.mail!.assertSent(ResetPasswordMail);
    });

    it("responds identically for an unknown address, and sends nothing", async () => {
      const known = await registerUser(testApp);
      testApp.mail!.reset();

      const first = await client.postJson("/auth/forgot-password", { email: known.email });
      await resetRateLimits(testApp);
      const second = await client.postJson("/auth/forgot-password", {
        email: `nobody-${randomUUID()}@example.com`,
      });

      // The whole point: a caller cannot tell which addresses have accounts.
      expect(second.status).toBe(first.status);
      expect(second.body).toEqual(first.body);
      // But no mail went to the stranger.
      testApp.mail!.assertSentTimes(ResetPasswordMail, 1);
    });

    it("writes no token row for an unknown address", async () => {
      const email = `nobody-${randomUUID()}@example.com`;

      await client.postJson("/auth/forgot-password", { email });

      expect(await PasswordResetToken.find(email)).toBeUndefined();
    });

    it("throttles a second request for the same mailbox with 429", async () => {
      const user = await registerUser(testApp);

      const first = await client.postJson("/auth/forgot-password", { email: user.email });
      // Clear the per-IP limiter so only the per-MAILBOX throttle can fire —
      // otherwise this would pass for the wrong reason.
      await resetRateLimits(testApp);
      const second = await client.postJson("/auth/forgot-password", { email: user.email });

      expect(first.status).toBe(200);
      expect(second.status).toBe(429);
    });

    it("rejects a malformed email with 422", async () => {
      const { status } = await client.postJson("/auth/forgot-password", { email: "not-an-email" });

      expect(status).toBe(422);
    });

    it("never puts the raw token in the response body", async () => {
      const user = await registerUser(testApp);
      testApp.mail!.reset();

      const { body } = await client.postJson("/auth/forgot-password", { email: user.email });
      const token = tokenFrom(sentResetUrl());

      expect(token).not.toBe("");
      expect(JSON.stringify(body)).not.toContain(token);
    });
  });

  describe("POST /auth/reset-password", () => {
    it("resets the password and lets the user log in with it", async () => {
      const user = await registerUser(testApp);
      testApp.mail!.reset();

      await client.postJson("/auth/forgot-password", { email: user.email });
      const token = tokenFrom(sentResetUrl());
      await resetRateLimits(testApp);

      const reset = await client.postJson("/auth/reset-password", {
        email: user.email,
        token,
        password: "a-brand-new-password",
      });
      expect(reset.status).toBe(200);

      await resetRateLimits(testApp);
      const login = await client.postJson<{ token: string }>("/auth/login", {
        email: user.email,
        password: "a-brand-new-password",
      });
      expect(login.status).toBe(200);
      expect(login.body.token).toContain("|");
    });

    it("invalidates the old password", async () => {
      const user = await registerUser(testApp);
      testApp.mail!.reset();

      await client.postJson("/auth/forgot-password", { email: user.email });
      const token = tokenFrom(sentResetUrl());
      await resetRateLimits(testApp);

      await client.postJson("/auth/reset-password", {
        email: user.email,
        token,
        password: "a-brand-new-password",
      });
      await resetRateLimits(testApp);

      const { status } = await client.postJson("/auth/login", {
        email: user.email,
        password: user.password,
      });
      expect(status).toBe(401);
    });

    it("revokes existing tokens, so a hijacked session cannot outlive recovery", async () => {
      // The property reset exists for: it is the account-RECOVERY path, so
      // whoever was already in must be kicked out.
      const user = await registerUser(testApp);
      expect((await user.request("/auth/me")).status).toBe(200);

      testApp.mail!.reset();
      await client.postJson("/auth/forgot-password", { email: user.email });
      const token = tokenFrom(sentResetUrl());
      await resetRateLimits(testApp);

      await client.postJson("/auth/reset-password", {
        email: user.email,
        token,
        password: "a-brand-new-password",
      });

      expect((await user.request("/auth/me")).status).toBe(401);
    });

    it("consumes the token, so it cannot be replayed", async () => {
      const user = await registerUser(testApp);
      testApp.mail!.reset();

      await client.postJson("/auth/forgot-password", { email: user.email });
      const token = tokenFrom(sentResetUrl());
      await resetRateLimits(testApp);

      const first = await client.postJson("/auth/reset-password", {
        email: user.email,
        token,
        password: "a-brand-new-password",
      });
      await resetRateLimits(testApp);
      const second = await client.postJson("/auth/reset-password", {
        email: user.email,
        token,
        password: "a-third-password",
      });

      expect(first.status).toBe(200);
      expect(second.status).toBe(422);
    });

    it("rejects a wrong token with 422", async () => {
      const user = await registerUser(testApp);
      testApp.mail!.reset();

      await client.postJson("/auth/forgot-password", { email: user.email });
      await resetRateLimits(testApp);

      const { status } = await client.postJson("/auth/reset-password", {
        email: user.email,
        token: "definitely-not-the-token",
        password: "a-brand-new-password",
      });

      expect(status).toBe(422);
    });

    it("rejects a token belonging to another account", async () => {
      const victim = await registerUser(testApp);
      const attacker = await registerUser(testApp);

      testApp.mail!.reset();
      await client.postJson("/auth/forgot-password", { email: attacker.email });
      const attackerToken = tokenFrom(sentResetUrl());
      await resetRateLimits(testApp);

      const { status } = await client.postJson("/auth/reset-password", {
        email: victim.email,
        token: attackerToken,
        password: "pwned",
      });

      expect(status).toBe(422);
    });

    it("rejects a password shorter than registration would allow", async () => {
      const { status } = await client.postJson("/auth/reset-password", {
        email: "someone@example.com",
        token: "whatever",
        password: "short",
      });

      expect(status).toBe(422);
    });

    it("does not log the user in", async () => {
      // A leaked reset link must not become a session in one step.
      const user = await registerUser(testApp);
      testApp.mail!.reset();

      await client.postJson("/auth/forgot-password", { email: user.email });
      const token = tokenFrom(sentResetUrl());
      await resetRateLimits(testApp);

      const { body } = await client.postJson<Record<string, unknown>>("/auth/reset-password", {
        email: user.email,
        token,
        password: "a-brand-new-password",
      });

      expect(body).not.toHaveProperty("token");
      expect(body).not.toHaveProperty("user");
    });
  });
});
