/**
 * Type-level dotted paths through a nested object/array, used by
 * `dataGet`/`dataSet`/`dataHas`/`dataForget`.
 *
 *   type Data = { user: { roles: string[] } };
 *   Paths<Data>          // "user" | "user.roles" | "user.roles.0" | "user.roles.*" | ...
 *   PathValue<Data, "user.roles.0">  // string
 *
 * Arrays accept numeric segments (`"0"`) and `*`. Objects accept their
 * own keys (including `"0"` as a normal string key). Index signatures
 * (`Record<string, V>`) allow any remaining dotted path.
 */

type Primitive =
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  | Date
  | ((...args: never[]) => unknown)
  | Map<unknown, unknown>
  | Set<unknown>;

type Depth = [never, 0, 1, 2, 3, 4, 5, 6, 7];

type HasStringIndex<T> = string extends keyof T ? true : false;

type Keyof<T> =
  Extract<keyof T, string | number> extends infer K
    ? K extends string | number
      ? `${K}`
      : never
    : never;

type ValuesOf<T> = T extends readonly unknown[] ? T[number] : T[keyof T];

type PathsOf<T, D extends number> = T extends unknown ? Paths<T, D> : never;

type ContainsStar<P extends string> = P extends
  `*` | `${string}*${string}` | `*${string}` | `${string}*`
  ? true
  : false;

/** One-level flatten: `(string[])[]` → `string[]`, matching Laravel `Arr::collapse`. */
type CollapseOne<T> = T extends (infer Item)[]
  ? Item extends (infer Inner)[]
    ? Inner[]
    : Item[]
  : T;

type ArrayPaths<T extends readonly unknown[], D extends number> =
  | `${number}`
  | "*"
  | (D extends 0 ? never : `${number}.${PathsOf<T[number], Depth[D]> & string}`)
  | (D extends 0 ? never : `*.${PathsOf<T[number], Depth[D]> & string}`);

type ObjectPaths<T extends object, D extends number> =
  HasStringIndex<T> extends true
    ? string
    : | Keyof<T>
      | "*"
      | (D extends 0
          ? never
          : {
              [K in Keyof<T>]: PathsOf<NonNullable<T[K & keyof T]>, Depth[D]> extends infer Rest
                ? Rest extends string
                  ? `${K}.${Rest}`
                  : never
                : never;
            }[Keyof<T>])
      | (D extends 0 ? never : `*.${PathsOf<NonNullable<ValuesOf<T>>, Depth[D]> & string}`);

/**
 * Every valid dotted path through `T` (capped at 7 segments to keep
 * instantiations bounded). `never` when `T` is a primitive/leaf.
 */
export type Paths<T, D extends number = 6> = [D] extends [never]
  ? never
  : [T] extends [Primitive]
    ? never
    : [T] extends [readonly unknown[]]
      ? ArrayPaths<T, D>
      : [T] extends [object]
        ? ObjectPaths<T, D>
        : never;

type Index<T, K extends string> = [unknown] extends [T]
  ? unknown
  : [T] extends [readonly unknown[]]
    ? K extends `${number}`
      ? K extends keyof T
        ? T[K]
        : T[number]
      : never
    : K extends keyof T
      ? T[K]
      : HasStringIndex<T> extends true
        ? T[K & keyof T]
        : never;

type WildcardGet<T, Rest extends string> = Rest extends ""
  ? ValuesOf<T>[]
  : ContainsStar<Rest> extends true
    ? CollapseOne<PathValue<ValuesOf<T>, Rest>[]>
    : PathValue<ValuesOf<T>, Rest>[];

type PathValueInner<T, P extends string> = [unknown] extends [T]
  ? unknown
  : P extends ""
    ? T
    : [T] extends [Primitive]
      ? never
      : string extends T
        ? T
        : P extends `*.${infer Rest}`
          ? WildcardGet<T, Rest>
          : P extends "*"
            ? WildcardGet<T, "">
            : P extends `${infer Head}.${infer Rest}`
              ? PathValueInner<Index<T, Head>, Rest>
              : Index<T, P>;

/**
 * The type sitting at dotted path `P` on `T` — what `dataGet` returns.
 * Wildcard segments (`*`) wrap the remainder in an array (and collapse
 * one extra array level when another `*` remains, matching runtime).
 */
export type PathValue<T, P extends string> = PathValueInner<NonNullable<T>, P>;

type WildcardAssign<T, Rest extends string> = Rest extends ""
  ? ValuesOf<T>
  : PathAssigned<ValuesOf<T>, Rest>;

type PathAssignedInner<T, P extends string> = [unknown] extends [T]
  ? unknown
  : P extends ""
    ? T
    : [T] extends [Primitive]
      ? never
      : string extends T
        ? T
        : P extends `*.${infer Rest}`
          ? WildcardAssign<T, Rest>
          : P extends "*"
            ? ValuesOf<T>
            : P extends `${infer Head}.${infer Rest}`
              ? PathAssignedInner<Index<T, Head>, Rest>
              : Index<T, P>;

/**
 * The type `dataSet`/`dataFill` accept at path `P`. Unlike `PathValue`,
 * a wildcard writes a *single* element type (one value applied to every
 * match), not an array of them.
 */
export type PathAssigned<T, P extends string> = PathAssignedInner<NonNullable<T>, P>;

/** Join a segment tuple `["user", "name"]` into `"user.name"`. */
export type JoinPath<P extends readonly string[]> = P extends readonly []
  ? never
  : P extends readonly [infer Only extends string]
    ? Only
    : P extends readonly [infer F extends string, ...infer R extends string[]]
      ? `${F}.${JoinPath<R>}`
      : never;

type Expect<T extends true> = T;
type Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type _Sample = {
  user: {
    address: { country: string };
    roles: string[];
  };
};

type _Users = { users: { name: string; active?: boolean }[] };
type _ObjZero = { "0": boolean };

export type _PathAsserts = [
  Expect<Eq<PathValue<_Sample, "user.address.country">, string>>,
  Expect<Eq<PathValue<_Sample, "user.roles.0">, string>>,
  Expect<Eq<PathValue<_Sample, "user.roles.*">, string[]>>,
  Expect<Eq<PathValue<_Users, "users.*.name">, string[]>>,
  Expect<Eq<PathValue<_ObjZero, "0">, boolean>>,
  Expect<Eq<PathValue<Record<string, unknown>, "database.default">, unknown>>,
  Expect<"user.address.foo" extends Paths<_Sample> ? false : true>,
  Expect<"user.roles.foo" extends Paths<_Sample> ? false : true>,
  Expect<string extends Paths<Record<string, unknown>> ? true : false>,
  Expect<Eq<PathAssigned<_Sample, "user.address.country">, string>>,
  Expect<Eq<PathAssigned<_Sample, "user.roles.*">, string>>,
  Expect<Eq<PathAssigned<_Users, "users.*.active">, boolean | undefined>>,
  Expect<Eq<JoinPath<["user", "address", "country"]>, "user.address.country">>,
];
