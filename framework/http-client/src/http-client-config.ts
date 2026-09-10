/** Per-client settings, as applied to a `PendingRequest` on creation. */
export interface HttpClientOptions {
  /** Prefix for relative request paths. Absolute URLs ignore it. */
  baseUrl?: string;
  /** Whole-exchange timeout in milliseconds — `fetch` has no separate connect timeout. */
  timeout?: number;
  /** Headers applied to every request, overridable per request. */
  headers?: Record<string, string>;
}

/**
 * The `http-client` config namespace — `app.config.get<HttpClientConfig>("http-client")`.
 *
 *   export default {
 *     timeout: 10_000,
 *     clients: {
 *       github: { baseUrl: "https://api.github.com", headers: { Accept: "application/vnd.github+json" } },
 *     },
 *   } satisfies HttpClientConfig;
 */
export interface HttpClientConfig extends HttpClientOptions {
  /** Named presets, resolved via `factory.client("github")`. */
  clients?: Record<string, HttpClientOptions>;
}
