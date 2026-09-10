export { GateRegistry, UserGate } from "./gate.js";
export type { Ability, BeforeCallback, AfterCallback } from "./gate.js";

export { Policy } from "./policy.js";
export type { PolicyClass, PolicyMethod, PolicyResult, ModelClass } from "./policy.js";

export { AuthorizationResponse, isAuthorizationResponse } from "./response.js";

export { requireAuth, requireGuest } from "./guards.js";

export { AuthorizationServiceProvider, GATE_TOKEN } from "./authorization-service-provider.js";
export { Gate } from "./gate-facade.js";

export { authorize, allows, denies, gate } from "./authorize.js";
export { can } from "./middleware/can.js";

import "./provider-hooks.js";
