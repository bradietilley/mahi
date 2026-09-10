/**
 * Optional `"health"` config namespace, read by `HealthServiceProvider`
 * with `?? {}` — an app that never sets it gets the defaults below.
 */
export interface HealthConfig {
  /**
   * Default per-check deadline, in seconds. Defaults to 5. Individual
   * checks override it with their own `timeoutSeconds`.
   */
  timeoutSeconds?: number;
  /**
   * How many checks run at once. Defaults to `1` — strictly sequential.
   *
   * Parallel is the tempting default and it is wrong for a probe. Every
   * check is I/O against a dependency that is *already suspected of being
   * unwell* — that is why it is being probed. Firing all of them at once,
   * once per probe interval, from every instance, is a synchronised burst
   * of connection attempts at exactly the moment the dependency can least
   * absorb it. A health check that amplifies the outage it was installed
   * to detect is a well-known operational hazard.
   *
   * Sequential also keeps the timeout composable: N checks at a 5s
   * deadline is a worst case of N×5s, which an operator can reason about
   * against their probe interval.
   */
  concurrency?: number;
}
