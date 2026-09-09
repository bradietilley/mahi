/**
 * Join a disk's configured `url` prefix with a disk-relative path.
 * The prefix may be a path (`"/storage"`) or an absolute URL
 * (`"https://cdn.example.com/media"`).
 */
export function joinPublicUrl(prefix: string, path: string): string {
  const base = prefix.replace(/\/+$/, "");
  const rel = encodeRelativePath(normalizeRelativePath(path));

  return `${base}/${rel}`;
}

/**
 * The path portion of a disk `url` prefix — the thing a request path
 * has to start with for `servePublicDisk` to treat it as a file on
 * that disk. Absolute URL prefixes contribute only their pathname, so
 * `url: "http://localhost:8000/storage"` still serves under `/storage`.
 */
export function publicUrlPathname(prefix: string): string {
  const trimmed = prefix.replace(/\/+$/, "");

  if (/^[a-zA-Z][a-zA-Z+.-]*:\/\//.test(trimmed)) {
    try {
      const pathname = new URL(trimmed).pathname.replace(/\/+$/, "");

      return pathname === "" ? "/" : pathname;
    } catch {
      return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
    }
  }

  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/**
 * Strip a disk's public URL prefix from an incoming request path.
 * Returns the disk-relative path, or `null` if the request isn't under
 * that prefix (or names no file).
 */
export function pathFromPublicUrl(requestPath: string, prefix: string): string | null {
  const prefixPath = publicUrlPathname(prefix);
  const normalized = requestPath.replace(/\\/g, "/");

  if (prefixPath === "/") {
    const rel = normalized.replace(/^\/+/, "");

    return rel === "" ? null : decodePath(rel);
  }

  if (normalized === prefixPath || normalized === `${prefixPath}/`) {
    return null;
  }

  if (!normalized.startsWith(`${prefixPath}/`)) {
    return null;
  }

  return decodePath(normalized.slice(prefixPath.length + 1));
}

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

/**
 * Percent-encode each path segment so a stored name containing spaces,
 * `?`, `#`, `%`, etc. produces a valid, unambiguous URL (`"a b.png"` →
 * `"a%20b.png"`, `"a?b=1#c.png"` → `"a%3Fb%3D1%23c.png"`). Segments are
 * encoded individually so the `/` separators survive; empty segments
 * (from a `//` in the path) are dropped.
 */
function encodeRelativePath(path: string): string {
  return path
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function decodePath(path: string): string | null {
  try {
    const decoded = decodeURIComponent(path);

    return decoded === "" ? null : decoded;
  } catch {
    return null;
  }
}
