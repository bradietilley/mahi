import type { PresenceResolver } from "./types.js";

let resolver: PresenceResolver | undefined;

export function setPresenceResolver(next: PresenceResolver | undefined): void {
  resolver = next;
}

export function getPresenceResolver(): PresenceResolver | undefined {
  return resolver;
}
