import { Collection } from "@mahiframework/core";
import type { EloquentBuilder, Hydrated } from "../eloquent-builder.js";
import type { RelationDefinitions } from "../relations.js";
import { clampPage } from "./clamp-page.js";

export interface SimplePaginationResult<T> {
  data: Collection<T>;
  page: number;
  perPage: number;
  hasMore: boolean;
}

/**
 * Offset-based pagination that skips the `COUNT(*)` query entirely,
 * Laravel's `Paginator` (`Model::simplePaginate()`), the cheaper sibling
 * of `paginate()`/`LengthAwarePaginator`. It fetches `perPage + 1` rows
 * (the "overfetch" trick `cursorPaginate()` already uses internally) and
 * infers "is there a next page" from whether that extra row came back,
 * then trims it off the returned `data`.
 *
 * Use when you only need next/prev navigation, not a total count or page
 * numbers. It saves the extra count query, which matters once a table is
 * large enough that `COUNT(*)` over the filtered set is a real cost.
 * When you DO need the total (page-number UIs), use `paginate()`.
 */
export async function simplePaginate<
  T extends Record<string, any>,
  TRel extends RelationDefinitions = Record<never, never>,
  TCasts = Record<never, never>,
  TInstance = Hydrated<T, TRel, TCasts>,
>(
  builder: EloquentBuilder<T, TRel, TCasts, TInstance>,
  requestedPage: number,
  requestedPerPage: number,
): Promise<SimplePaginationResult<TInstance>> {
  const { page, perPage } = clampPage(requestedPage, requestedPerPage);

  const rows = await builder
    .limit(perPage + 1)
    .offset((page - 1) * perPage)
    .get();

  const hasMore = rows.count() > perPage;
  const data = hasMore ? Collection.make(rows.toArray().slice(0, perPage)) : rows;

  return { data, page, perPage, hasMore };
}
