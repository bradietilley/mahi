export interface TimestampResolver {
  timestamp(): number | Promise<number>;
}

export type TimestampResolverFn = () => number | Promise<number>;
