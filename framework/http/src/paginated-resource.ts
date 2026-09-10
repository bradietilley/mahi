import type { LengthAwarePaginationResult, CursorPaginationResult } from "@mahi/database";
import type { Resource } from "./resource.js";

export interface PaginationMeta {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
}

export interface PaginatedResourceResult<TShape> extends PaginationMeta {
  data: TShape[];
}

/** Pagination metadata nested under `meta`, Laravel's `AnonymousResourceCollection` shape. */
export interface NestedPaginatedResourceResult<TShape> {
  data: TShape[];
  meta: PaginationMeta;
}

export interface PaginatedResourceOptions {
  /**
   * Extra top-level fields merged into the envelope — Laravel's
   * `->additional([...])`. Handy for a `requestId`, a computed summary,
   * etc. without hand-rolling the object literal in the controller.
   */
  additional?: Record<string, unknown>;
  /**
   * Nest the pagination fields under a `meta` key instead of spreading
   * them at the top level (Laravel's default resource-collection shape).
   */
  nestMeta?: boolean;
}

/**
 * Turns a `LengthAwarePaginationResult<TModel>` (from `@mahi/
 * database`'s `paginate()`/`Model.paginate()`) into an HTTP JSON envelope,
 * transforming each row through the given `Resource` subclass while
 * preserving the `page`/`perPage`/`total`/`totalPages`/`hasMore` metadata.
 *
 *   const page = await Todo.paginate(1, 20);
 *   return c.json(paginatedResource(TodoResource, page));
 *
 * Optionally merge extra top-level fields (`additional`) or nest the
 * pagination fields under `meta` (`nestMeta`):
 *
 *   return c.json(paginatedResource(TodoResource, page, { additional: { requestId } }));
 *   return c.json(paginatedResource(TodoResource, page, { nestMeta: true }));
 */
export async function paginatedResource<TModel, TShape>(
  ResourceClass: new (model: TModel) => Resource<TModel, TShape>,
  result: LengthAwarePaginationResult<TModel>,
  options: PaginatedResourceOptions = {},
): Promise<
  (PaginatedResourceResult<TShape> | NestedPaginatedResourceResult<TShape>) &
    Record<string, unknown>
> {
  const data = await Promise.all(result.data.toArray().map((m) => new ResourceClass(m).toJson()));
  const meta: PaginationMeta = {
    page: result.page,
    perPage: result.perPage,
    total: result.total,
    totalPages: result.totalPages,
    hasMore: result.hasMore,
  };

  const envelope = options.nestMeta ? { data, meta } : { data, ...meta };

  return { ...envelope, ...options.additional };
}

export interface CursorPaginatedResourceResult<TShape> {
  data: TShape[];
  nextCursor: string | null;
  prevCursor: string | null;
}

export interface CursorPaginatedResourceOptions {
  /** Extra top-level fields merged into the envelope — Laravel's `->additional([...])`. */
  additional?: Record<string, unknown>;
}

/**
 * The cursor-pagination equivalent of `paginatedResource()` — wraps a
 * `CursorPaginationResult<TModel>` (from `Todo.cursorPaginate()`/
 * `cursorPaginate()`), preserving `nextCursor`/`prevCursor` unchanged.
 * Extra top-level fields can be merged via `additional`.
 */
export async function cursorPaginatedResource<TModel, TShape>(
  ResourceClass: new (model: TModel) => Resource<TModel, TShape>,
  result: CursorPaginationResult<TModel>,
  options: CursorPaginatedResourceOptions = {},
): Promise<CursorPaginatedResourceResult<TShape> & Record<string, unknown>> {
  return {
    nextCursor: result.nextCursor,
    prevCursor: result.prevCursor,
    data: await Promise.all(result.data.toArray().map((m) => new ResourceClass(m).toJson())),
    ...options.additional,
  };
}
