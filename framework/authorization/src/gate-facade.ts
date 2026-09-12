import { Facade } from "@mahiframework/facades";
import type { GateRegistry, UserGate } from "./gate.js";
import type { ModelClass } from "./policy.js";
import { GATE_TOKEN } from "./tokens.js";

/**
 * Thin facade over the `GateRegistry` singleton bound at `GATE_TOKEN`.
 *
 * The class is `GateRegistry` and the facade is `Gate` — the name written
 * at call sites — mirroring how `Hash`/`Crypt` front `Hasher`/
 * `Encrypter`.
 *
 *   await Gate.authorize("update", Todo, todo);   // throws 403 if denied
 *   if (await Gate.allows("create", Todo)) { ... }
 *   await Gate.forUser(someUser).allows("update", Todo, todo);
 *
 * The user is implicit, read from `@mahiframework/auth`'s ALS scope. Use
 * `forUser()` where there is no request (queue jobs, CLI commands).
 */
export class Gate extends Facade<GateRegistry>(() => GATE_TOKEN) {
  static allows(ability: string, ...args: unknown[]): Promise<boolean> {
    return this.instance().allows(ability, ...args);
  }

  static denies(ability: string, ...args: unknown[]): Promise<boolean> {
    return this.instance().denies(ability, ...args);
  }

  static authorize(ability: string, ...args: unknown[]): Promise<void> {
    return this.instance().authorize(ability, ...args);
  }

  static forUser<TUser = unknown>(user: TUser | null): UserGate {
    return this.instance().forUser(user);
  }

  static abilitiesFor(
    abilities: string[],
    model: ModelClass,
    row?: unknown,
  ): Promise<Record<string, boolean>> {
    return this.instance().abilitiesFor(abilities, model, row);
  }
}
