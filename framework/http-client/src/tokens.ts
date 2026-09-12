/**
 * Container binding for the `HttpClientFactory`. Package-private: nothing
 * outside `@mahiframework/http-client` resolves it, so it stays here rather than in
 * `@mahiframework/core`'s `well-known-tokens.ts`, which is reserved for genuinely
 * cross-package tokens.
 */
export const HTTP_CLIENT_TOKEN = "http-client";
