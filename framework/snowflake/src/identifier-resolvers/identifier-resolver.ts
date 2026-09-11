export interface IdentifierResolver {
  identifier(
    time: number,
    sequence: number,
    group?: string | null,
  ): bigint | number | Promise<bigint | number>;
}

export type IdentifierResolverFn = (
  time: number,
  sequence: number,
  group: string | null,
) => bigint | number | Promise<bigint | number>;
