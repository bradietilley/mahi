/**
 * Normalises a `page`/`perPage` pair into the range the offset
 * paginators can actually compile: `page >= 1`, `perPage >= 1`, both
 * whole numbers.
 *
 * These values almost always come straight off a query string
 * (`?page=0`, `?page=-1`, `?page=abc`), and the arithmetic is
 * unforgiving: `(page - 1) * perPage` is a **negative `OFFSET`** for any
 * page below 1, which Postgres rejects outright ("OFFSET must not be
 * negative") and MySQL treats as a syntax error, turning a junk query
 * param into a 500. A fractional `perPage` compiles to a fractional
 * `LIMIT`, likewise invalid.
 *
 * Clamping rather than throwing matches Laravel (whose `Paginator`
 * resolves any non-positive page to 1) and keeps a bad link a harmless
 * "first page" instead of an error page. `cursorPaginate()` already did
 * this for its own `perPage`; this is the shared version.
 */
export function clampPage(page: number, perPage: number): { page: number; perPage: number } {
  return {
    page: Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1,
    perPage: Number.isFinite(perPage) ? Math.max(1, Math.floor(perPage)) : 1,
  };
}
