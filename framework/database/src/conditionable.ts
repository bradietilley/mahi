/**
 * Shared `when`/`unless` implementation for `QueryBuilder` and
 * `EloquentBuilder` — Laravel's `Conditionable`, minus the
 * `HigherOrderWhenProxy` magic form.
 *
 * A function `value` is invoked with the builder to produce the
 * condition; otherwise `value` is used as-is. The callback's return is
 * kept when it isn't `null`/`undefined`; otherwise the builder is
 * returned so a void callback still chains.
 */
export function applyWhen<TBuilder, TValue, TReturn>(
  builder: TBuilder,
  value: TValue | ((builder: TBuilder) => TValue),
  callback: (builder: TBuilder, value: TValue) => TReturn | void,
  defaultCb: ((builder: TBuilder, value: TValue) => TReturn | void) | undefined,
  negate: boolean,
): TBuilder | TReturn {
  const resolved: TValue =
    typeof value === "function" ? (value as (current: TBuilder) => TValue)(builder) : value;
  const matched = negate ? !resolved : Boolean(resolved);

  if (matched) {
    return (callback(builder, resolved) as TReturn | undefined) ?? builder;
  }

  if (defaultCb) {
    return (defaultCb(builder, resolved) as TReturn | undefined) ?? builder;
  }

  return builder;
}
