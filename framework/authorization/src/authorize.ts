import { app } from "@mahiframework/core";
import type { GateRegistry } from "./gate.js";
import { GATE_TOKEN } from "./tokens.js";

/**
 * In-controller authorization helpers.
 *
 * Take no `Context` — like `Auth.user()`, they read the ambient
 * AsyncLocalStorage auth scope. Prefer these over the `can()` middleware
 * when the row is needed by the handler anyway (the middleware would load
 * it a second time), or when the check is conditional:
 *
 *   const todo = await request.model(Todo);
 *   await authorize("update", Todo, todo);
 *
 * Prefer `can()` for uniform CRUD, where having the check visible in the
 * route table is genuinely valuable for auditing what protects an
 * endpoint.
 */
export function gate(): GateRegistry {
  return app().make<GateRegistry>(GATE_TOKEN);
}

/** Throws `HttpError.forbidden()` if denied. */
export function authorize(ability: string, ...args: unknown[]): Promise<void> {
  return gate().authorize(ability, ...args);
}

export function allows(ability: string, ...args: unknown[]): Promise<boolean> {
  return gate().allows(ability, ...args);
}

export function denies(ability: string, ...args: unknown[]): Promise<boolean> {
  return gate().denies(ability, ...args);
}
