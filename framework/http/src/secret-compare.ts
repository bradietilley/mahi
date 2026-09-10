import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time comparison of a request-supplied secret against a
 * configured one.
 *
 * A plain `===` short-circuits on the first differing byte, so the time it
 * takes to reject a wrong secret depends on how many leading bytes were
 * right — enough for an attacker to recover the secret one byte at a time.
 * Every place that gates access on a shared secret (maintenance bypass,
 * health-check message redaction) must go through this instead.
 *
 * Lengths are compared first because `timingSafeEqual` throws on
 * mismatched buffers; that leaks only the length, which is not the secret.
 */
export function secretMatches(candidate: string | undefined, secret: string): boolean {
  if (candidate === undefined) {
    return false;
  }

  const a = Buffer.from(candidate);
  const b = Buffer.from(secret);

  return a.length === b.length && timingSafeEqual(a, b);
}
