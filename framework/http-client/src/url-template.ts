import { encodeNested } from "./query-encoder.js";

/**
 * Expands `{placeholder}` segments in a URL from `withUrlParameters()` —
 * Laravel's `PendingRequest::withUrlParameters()`, which uses a
 * `UriTemplate` for the same job.
 *
 *   expandUrlTemplate("https://{host}/repos/{repo}", { host: "api.github.com", repo: "mahi" })
 *   // "https://api.github.com/repos/mahi"
 *
 * Values are percent-encoded, so a parameter can't inject path segments or
 * a query string. Placeholders with no matching parameter are left as-is
 * rather than blanked — a literal `{` in a URL is legal, and silently
 * deleting part of the path is worse than leaving it visible.
 */
export function expandUrlTemplate(url: string, params: Record<string, string | number>): string {
  if (Object.keys(params).length === 0) {
    return url;
  }

  return url.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];

    return value === undefined ? match : encodeURIComponent(String(value));
  });
}

/**
 * Joins a `baseUrl()` and a per-request path. An absolute URL wins outright
 * (matching Laravel, where `baseUrl` is a prefix for relative paths only);
 * otherwise exactly one slash sits between the two.
 */
export function resolveUrl(baseUrl: string | undefined, url: string): string {
  // Absolute means "has a scheme" (`ws://`, `data:`, …) or is
  // protocol-relative (`//host/path`), not just `http(s)://` — any of
  // those prefixed with a base URL would be nonsense.
  if (!baseUrl || /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//")) {
    return url;
  }

  return `${baseUrl.replace(/\/+$/, "")}/${url.replace(/^\/+/, "")}`;
}

/**
 * Appends query parameters to a URL, preserving any already present.
 * Arrays and nested objects expand to bracket notation (`?tag[0]=a&tag[1]=b`,
 * `?filter[status]=active`), the inverse of `@mahi/http`'s query parser;
 * `null`/`undefined` values are skipped rather than serialized as the
 * string `"null"`.
 */
export function appendQuery(url: string, params: Record<string, unknown>): string {
  const fields = encodeNested(params);

  if (fields.length === 0) {
    return url;
  }

  const [base, existing = ""] = splitQuery(url);
  const search = new URLSearchParams(existing);

  for (const [key, value] of fields) {
    search.append(key, value);
  }

  const query = search.toString();

  return query === "" ? base : `${base}?${query}`;
}

/** Splits a URL into its pre-`?` part and its query string, ignoring any fragment. */
function splitQuery(url: string): [string, string?] {
  const index = url.indexOf("?");

  return index === -1 ? [url] : [url.slice(0, index), url.slice(index + 1)];
}
