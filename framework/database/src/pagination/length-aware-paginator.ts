import type { Collection } from "@mahiframework/core";
import type { EloquentBuilder, Hydrated } from "../eloquent-builder.js";
import type { RelationDefinitions } from "../relations.js";
import { clampPage } from "./clamp-page.js";

export interface LengthAwarePaginationResult<T> {
  data: Collection<T>;
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
}

/**
 * Offset-based pagination, `page`/`perPage`, returns total count + total
 * pages, matching Laravel's `LengthAwarePaginator` (`Model::paginate()`).
 * Simple, familiar, correct for small-to-medium datasets and admin-style
 * UIs with page numbers. Weak point (same as Laravel's): `OFFSET` gets
 * slower on very large tables/deep pages, and results can shift under
 * concurrent writes between page loads. `cursorPaginate()` is the
 * documented answer for that case, not a third paginator type.
 *
 * `builder.count()` counts rows matching the builder's accumulated
 * `where()` conditions but ignores `orderBy()`/`limit()`/`offset()` (see
 * `QueryBuilder.count()`'s docstring). This is what makes `total`/
 * `totalPages` correct for a filtered query even though the same builder
 * also has a page-sized `limit`/`offset` applied for the `data` fetch.
 */
export async function paginate<
  T extends Record<string, any>,
  TRel extends RelationDefinitions = Record<never, never>,
  TCasts = Record<never, never>,
  TInstance = Hydrated<T, TRel, TCasts>,
>(
  builder: EloquentBuilder<T, TRel, TCasts, TInstance>,
  requestedPage: number,
  requestedPerPage: number,
): Promise<LengthAwarePaginationResult<TInstance>> {
  const { page, perPage } = clampPage(requestedPage, requestedPerPage);

  // Count on a clone, and before paging the original: builders mutate in
  // place, so counting the same instance concurrently with a `limit()`/
  // `offset()` call is order-dependent and, against a single SQLite
  // connection, has both statements interleaving on one handle. The
  // count deliberately ignores limit/offset either way; this just makes
  // the two queries independent.
  const total = await builder.clone().count();
  const data = await builder
    .limit(perPage)
    .offset((page - 1) * perPage)
    .get();

  const totalPages = Math.ceil(total / perPage);

  return {
    data,
    page,
    perPage,
    total,
    totalPages,
    hasMore: page < totalPages,
  };
}
