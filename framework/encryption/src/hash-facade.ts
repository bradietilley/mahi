import { Facade } from "@mahiframework/facades";
import type { Hasher } from "./hasher.js";
import { HASHER_TOKEN } from "./encryption-service-provider.js";

/**
 * Thin facade over the `Hasher` singleton bound at `HASHER_TOKEN`, for
 * call sites that would otherwise read
 * `app().make<Hasher>(HASHER_TOKEN).make(...)`. Matches
 * Laravel's `Illuminate\Support\Facades\Hash`.
 *
 *   const hash = await Hash.make("user-password");
 *   const matches = await Hash.check("user-password", hash);
 *
 * Prefer constructor-injecting `Hasher` (via `HASHER_TOKEN`) where that's
 * practical (e.g. inside a `ServiceProvider`/`Command` that already
 * receives `app`), use this only at call sites where threading
 * `app`/`Hasher` through is genuinely inconvenient, same guidance as
 * `app()` itself.
 */
export class Hash extends Facade<Hasher>(() => HASHER_TOKEN) {
  static make(value: string): Promise<string> {
    return this.instance().make(value);
  }

  static check(value: string, hash: string): Promise<boolean> {
    return this.instance().check(value, hash);
  }

  static needsRehash(hash: string): boolean {
    return this.instance().needsRehash(hash);
  }
}
