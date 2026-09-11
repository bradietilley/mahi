export interface SequenceResolver {
  sequence(currentTime: number): number | Promise<number>;
}

export type SequenceResolverFn = (currentTime: number) => number | Promise<number>;
