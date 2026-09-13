/**
 * `@mahiframework/health`, a registry of named readiness probes, one runner, two
 * frontends.
 *
 * An app declares "these are the things that must be working" via the
 * `checks()` provider hook, and gets both `GET /health` and
 * `./artisan health` automatically, sharing one runner and one result shape:
 *
 *     {"core":{"cache":true,"database":true,"filesystem":true},
 *      "app":{"daemon":true,"stripe":"Failed to connect"}}
 *
 * `true` = passed, a string = why it failed, `null` = skipped.
 *
 * ## Liveness vs readiness, do not collapse these
 *
 * `@mahiframework/http` registers an opt-in zero-I/O `GET /up` (`http.liveness`);
 * this package registers an opt-in `GET /health` (`http.healthCheck`)
 * that runs every check. They are the two halves of the standard split:
 * `/up` answers "is the process alive?" (k8s `livenessProbe`; failure
 * means restart the pod), `/health` answers "should this instance receive
 * traffic?" (k8s `readinessProbe`; failure means drain it, leave it
 * running).
 *
 * Collapsing them is a mistake in the expensive direction. If `/up`
 * started doing real I/O, a Redis blip would fail the *liveness* probe
 * and the orchestrator would **restart every pod in the deployment**,
 * turning a recoverable dependency outage into a full outage plus a
 * thundering-herd reconnect. That failure mode is the entire reason the
 * two-probe split exists.
 *
 * `/health` is deliberately **not** maintenance-exempt, while `/up` is:
 * an orchestrator must be able to tell a down-for-maintenance app from a
 * dead one, but a readiness probe answering "ready" while an operator has
 * explicitly taken the app down would put traffic back on it.
 */

export {
  HealthRegistry,
  withTimeout,
  messageFor,
  DEFAULT_GROUP,
  DEFAULT_TIMEOUT_SECONDS,
} from "./health-registry.js";
export type { HealthCheck, CheckOutcome, HealthResults, HealthReport } from "./health-check.js";
export type { HealthConfig } from "./health-config.js";
export { HealthServiceProvider, HEALTH_TOKEN } from "./health-service-provider.js";
export { cacheCheck, databaseCheck, filesystemCheck } from "./checks/index.js";
export type {
  CacheManagerLike,
  CacheStoreLike,
  DatabaseManagerLike,
  KyselyLike,
  StorageDriverLike,
  StorageManagerLike,
} from "./checks/index.js";
export { HealthCommand } from "./commands/health.js";

import "./provider-hooks.js";
