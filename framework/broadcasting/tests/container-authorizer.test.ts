import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { Application } from "@mahi/core";
import { ContainerBroadcastAuthorizer, type SignerLike } from "../src/container-authorizer.js";
import { ChannelRegistry } from "../src/channel-registry.js";

/** A minimal HMAC signer with the same `sign`/`verify`/`for` shape as `@mahi/encryption`'s. */
class FakeSigner implements SignerLike {
  constructor(private readonly secret = "test-secret") {}
  for(purpose: string): SignerLike {
    return new FakeSigner(`${this.secret}:${purpose}`);
  }
  sign(payload: string): string {
    return `${payload}.${createHmac("sha256", this.secret).update(payload).digest("base64url")}`;
  }
  verify(signed: string): string | null {
    const dot = signed.lastIndexOf(".");

    if (dot === -1) {
      return null;
    }

    const payload = signed.slice(0, dot);

    return this.sign(payload) === signed ? payload : null;
  }
}

function authorizer(
  signer?: SignerLike | (() => SignerLike | undefined),
): ContainerBroadcastAuthorizer {
  return new ContainerBroadcastAuthorizer(
    new Application(),
    new ChannelRegistry(),
    ["session"],
    signer,
  );
}

describe("ContainerBroadcastAuthorizer grants", () => {
  it("mints and verifies a grant bound to its channel", () => {
    const auth = authorizer(new FakeSigner());
    const grant = auth.mintGrant("private-orders.1", 60_000);
    expect(grant).toBeTypeOf("string");

    expect(auth.verifyGrant("private-orders.1", grant!)).toEqual({ authorized: true });
  });

  it("refuses a grant replayed on a different channel", () => {
    const auth = authorizer(new FakeSigner());
    const grant = auth.mintGrant("private-orders.1", 60_000)!;
    expect(auth.verifyGrant("private-orders.2", grant)).toBeNull();
  });

  it("refuses an expired grant", () => {
    vi.useFakeTimers();
    try {
      const auth = authorizer(new FakeSigner());
      const grant = auth.mintGrant("private-orders.1", 1_000)!;
      vi.advanceTimersByTime(2_000);
      expect(auth.verifyGrant("private-orders.1", grant)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a tampered grant", () => {
    const auth = authorizer(new FakeSigner());
    const grant = auth.mintGrant("private-orders.1", 60_000)!;
    expect(auth.verifyGrant("private-orders.1", `${grant}x`)).toBeNull();
  });

  it("round-trips presence member data through a presence grant", () => {
    const auth = authorizer(new FakeSigner());
    const grant = auth.mintGrant("presence-chat.1", 60_000, { id: "7", name: "Ada" })!;
    expect(auth.verifyGrant("presence-chat.1", grant)).toEqual({
      authorized: true,
      presenceData: { id: "7", name: "Ada" },
    });
  });

  it("mints nothing and verifies nothing without a signer", () => {
    const auth = authorizer(undefined);
    expect(auth.mintGrant("private-x", 1_000)).toBeNull();
    expect(auth.verifyGrant("private-x", "anything")).toBeNull();
  });
});

/**
 * The provider passes a THUNK, not a signer — resolving the container's
 * signer eagerly builds the encrypter, which throws on a missing
 * `APP_KEY` and takes boot down with it (see the provider's docstring).
 * The tests above all pass a signer directly, which is the
 * backwards-compatible branch; these cover the branch production uses.
 */
describe("ContainerBroadcastAuthorizer lazy signer", () => {
  it("does not call the thunk until a grant operation needs it", () => {
    const resolve = vi.fn(() => new FakeSigner());

    const auth = authorizer(resolve);
    // Constructing the authorizer happens during boot, which is exactly
    // when the signer must not be built.
    expect(resolve).not.toHaveBeenCalled();

    expect(auth.mintGrant("private-orders.1", 60_000)).toBeTypeOf("string");
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("resolves the signer once and reuses it", () => {
    const resolve = vi.fn(() => new FakeSigner());
    const auth = authorizer(resolve);

    const grant = auth.mintGrant("private-orders.1", 60_000)!;
    expect(auth.verifyGrant("private-orders.1", grant)).toEqual({ authorized: true });
    expect(auth.mintGrant("private-orders.2", 60_000)).toBeTypeOf("string");

    // Memoized: three operations, one resolution — and one `.for()`
    // scoping, so the purpose separation isn't re-derived per call.
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("round-trips a grant through a thunk-resolved signer", () => {
    const auth = authorizer(() => new FakeSigner());
    const grant = auth.mintGrant("presence-chat.1", 60_000, { id: "7", name: "Ada" })!;

    expect(auth.verifyGrant("presence-chat.1", grant)).toEqual({
      authorized: true,
      presenceData: { id: "7", name: "Ada" },
    });
    expect(auth.verifyGrant("presence-chat.2", grant)).toBeNull();
  });

  it("treats a thunk that resolves nothing as having no signer, without retrying", () => {
    const resolve = vi.fn((): SignerLike | undefined => undefined);
    const auth = authorizer(resolve);

    expect(auth.mintGrant("private-x", 1_000)).toBeNull();
    expect(auth.verifyGrant("private-x", "anything")).toBeNull();
    // `null` is cached as "resolved to nothing" — a second miss must not
    // hit the container again.
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});
