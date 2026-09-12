import { Facade } from "@mahiframework/facades";
import type { Encrypter } from "./encrypter.js";
import { ENCRYPTER_TOKEN } from "./encryption-service-provider.js";

/**
 * Thin facade over the `Encrypter` singleton bound at `ENCRYPTER_TOKEN`,
 * for call sites that would otherwise read
 * `app().make<Encrypter>(ENCRYPTER_TOKEN).encrypt(...)`.
 * Matches Laravel's `Illuminate\Support\Facades\Crypt`.
 *
 *   const encrypted = Crypt.encrypt("sensitive value");
 *   const original = Crypt.decrypt(encrypted);
 *
 * Prefer constructor-injecting `Encrypter` (via `ENCRYPTER_TOKEN`) where
 * that's practical (e.g. inside a `ServiceProvider`/`Command` that
 * already receives `app`) — reach for this only at call sites where
 * threading `app`/`Encrypter` through is genuinely inconvenient, same
 * guidance as `app()` itself.
 */
export class Crypt extends Facade<Encrypter>(() => ENCRYPTER_TOKEN) {
  /** `aad` binds the ciphertext to a context — see `Encrypter.encrypt()`. */
  static encrypt(value: string, aad?: string): string {
    return this.instance().encrypt(value, aad);
  }

  /** `aad` must match what `encrypt()` was given, or this throws. */
  static decrypt(payload: string, aad?: string): string {
    return this.instance().decrypt(payload, aad);
  }
}
