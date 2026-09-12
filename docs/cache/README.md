# Cache

`@mahiframework/cache` is three things layered on one small interface: a
key/value `CacheStore`, a mutual-exclusion `Lock` built on that store's
atomic `add()`, and a `RateLimiter` built on its atomic `increment()`.

```ts
import { Cache } from "@mahiframework/cache";

await Cache.put("feed:427185966743560456", posts, 300);
const cached = await Cache.get<Post[]>("feed:427185966743560456");

const feed = await Cache.remember("feed:global", () => buildGlobalFeed(), 60);
```

Two stores ship in the box — `array` (in-process `Map`) and `file` (JSON
on disk). `@mahiframework/redis` adds a third. All three implement the same
nine-method interface, so nothing above the store layer changes when you
switch.

## The `CacheStore` contract

```ts
interface CacheStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  forget(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
  flush(): Promise<void>;
  increment(key: string, amount?: number): Promise<number>;
  add<T = unknown>(key: string, value: T, ttlSeconds?: number): Promise<boolean>;
  remember<T>(key: string, callback: () => T | Promise<T>, ttlSeconds?: number | null): Promise<T>;
  rememberViaLock<T>(key: string, callback: () => T | Promise<T>, ttlSeconds?: number | null): Promise<T>;
  lock(options: LockOptions): Lock;

  // Optional — see "Store guarantees" below.
  releaseLock?(key: string, owner: string): Promise<boolean>;
  prune?(): number | Promise<number>;
}
```

That's the whole surface. It is deliberately narrower than Laravel's
`Repository` + `LockProvider`, and the omissions are intentional rather
than accidental:

**There is no `forever()` or `rememberForever()`.** "Forever" is what you
get by omitting `ttlSeconds`:

```ts
await Cache.put("app:settings", settings);          // no expiry
await Cache.remember("app:settings", load);         // ttlSeconds defaults to null = no expiry
```

**There is no `decrement()`.** Pass a negative amount to `increment()` —
which is exactly what `RateLimiter.decrement()` does internally
(`this.increment(key, decaySeconds, amount * -1)`).

```ts
await Cache.increment("stock:sku-1", -1);
```

**There is no `many()` / `putMany()` / `pull()` / `forgetMany()`.** Batch
reads and read-and-delete are not modelled. Loop, or reach for the
underlying client through a driver you own.

**There are no cache tags.** Tag invalidation requires either a
tag-index-per-key scheme (correctness problems on every non-Redis store)
or `SCAN`-based prefix deletion (Redis-specific). Namespace your keys
instead — `feed:user:{id}` — and delete by writing the keys you know.

### TTL is always seconds, always absolute, always lazy

`ttlSeconds` is in **seconds** everywhere in this package. The one place
milliseconds ever appeared was `LockOptions`, and both millisecond spellings
there are now `@deprecated` aliases (see [Locks](#locks)).

A TTL is converted to an **absolute expiry timestamp at write time**:

```ts
// ArrayCacheStore.put()
this.store.set(key, {
  value,
  expiresAt: ttlSeconds !== undefined ? Date.now() + ttlSeconds * 1000 : undefined,
});
```

Expiry is evaluated **lazily on read** — a `get()`/`has()` that finds an
entry past its `expiresAt` deletes it and reports a miss. So an entry
written and never read again occupies memory (or an inode) until something
touches that key.

That is fine for a key space you read back, and a leak for one you don't.
The case that bites is `RateLimiter`: it writes `throttle:<name>:<ip>`
and a `:timer` sibling for every distinct client, and never looks at
either again once the window passes. In a long-running server that is two
dead entries per IP you have ever served.

Both built-in stores therefore also expire **eagerly**:

| Store | Eager expiry |
|---|---|
| `ArrayCacheStore` | Sweeps itself every `sweepIntervalSeconds` (default 60, `0` to disable). The timer is `unref()`ed, so it can never keep a process alive. |
| `FileCacheStore` | `prune()`, on demand — a full directory walk, so its cost belongs to a scheduled task rather than an unlucky request. |
| `RedisCacheStore` | Redis does it, both lazily and on its own background cycle. No `prune()`. |

```ts
schedule.command("cache:prune").hourly();
```

`./artisan cache:prune` calls `prune()` on the default store (or
`--store <name>`), and reports rather than fails on a store that has none
— so a scheduled task doesn't break the day `cache.default` changes.

### `increment()` preserves the existing expiry

This is the single most important behavioural detail in the package,
because `RateLimiter` is built on it.

```ts
// ArrayCacheStore.increment()
const existing = this.liveEntry(key);
const current = numericValue(key, existing?.value);
const next = current + amount;
this.store.set(key, { value: next, expiresAt: existing?.expiresAt });
```

The entry's `expiresAt` is carried forward untouched. Incrementing a
counter does **not** extend its window. If it did, a rate limit of "5 per
minute" would become "5 per minute of silence" — every hit would push the
reset a further minute out, and a client hitting steadily would be locked
out forever. `RedisCacheStore.increment()` gets the same semantics for
free, because Redis `INCRBY` preserves a key's TTL.

A counter incremented into existence (no prior entry) has **no** expiry —
`existing?.expiresAt` is `undefined`. That's why `RateLimiter.increment()`
seeds the key with `add(key, 0, decaySeconds)` first: `add()` sets the
TTL, `increment()` then counts within it.

**Incrementing a non-numeric value throws**, on every store.

```ts
await Cache.put("name", "5");
await Cache.increment("name");   // throws: "5" is not a number
```

`"5" + 1` in JavaScript is `"51"`, so a store that just added would
silently turn a cached string into nonsense and keep going. Redis rejects
the same operation server-side (`ERR value is not an integer`), and a
store disagreeing with the others here would make the bug visible only
under one `CACHE_STORE`.

### `add()` returns true only if it set the key

```ts
const first = await Cache.add("import:lock", "running", 300);   // true
const second = await Cache.add("import:lock", "running", 300);  // false
```

"Set only if absent (or expired)". This is the primitive `Lock.acquire()`
is built on and the primitive `RateLimiter` uses to seed a window's timer
exactly once. It is a *store-level* atomicity contract, not a convenience
— see [Store atomicity](#store-atomicity) for what implementations must
guarantee.

### `remember()` and `rememberViaLock()`

```ts
remember(key, callback, ttlSeconds = null)
```

Get-or-compute-and-store. Returns the cached value when present; otherwise
runs `callback`, stores the result, returns it. `ttlSeconds` defaults to
`null` — **no expiry**. Pass a number for a bounded lifetime.

The miss check is `value !== undefined`. A cached `null`, `0`, `""` or
`false` is a **hit**; only `undefined` is a miss. That means a callback
that returns `undefined` is re-run on every call and its result is never
usefully cached.

```ts
const trending = await Cache.remember(
  "hashtags:trending",
  () => Hashtag.query().orderByDesc("post_count").limit(10).get(),
  300,
);
```

```ts
rememberViaLock(key, callback, ttlSeconds = null)
```

Same contract, but the compute-and-store step runs inside a `Lock` on the
same key, so a cache-miss stampede only runs `callback()` once. The exact
sequence:

1. `get(key)` — return it if present. No lock is taken on the happy path.
2. Acquire `Lock({ key, automaticReleaseAfterSeconds: 30 })`. Waiters
   block **indefinitely** — `maximumWaitForSeconds` is not set, so the
   default is `Infinity`.
3. Re-check `get(key)` while holding the lock — the winner has probably
   populated it by now, and every waiter returns that value without
   computing.
4. Otherwise compute, `put()`, release.

Use it when the callback is expensive or side-effecting enough that
running it N times concurrently is a real problem. The costs are one extra
`add()` + `get()` + `forget()` round-trip per miss, and the fact that
waiters block with no timeout. On a store whose `add()` is only atomic
in-process (array, file), the deduplication is only within one process;
on Redis it's genuinely global.

Laravel has no first-class equivalent — the closest is pairing
`Cache::lock()` with `remember()` by hand.

## Store guarantees

Read this table before picking `cache.default`. Everything above the store
layer is identical across the three; everything that can actually hurt you
is in here.

| | `array` | `file` | `redis` |
|---|---|---|---|
| Survives a restart | No | **Yes** | **Yes** |
| Shared between processes on one host | No | **Yes** | **Yes** |
| Shared between hosts | No | No | **Yes** |
| `add()` atomic within one process | Yes | Yes | Yes |
| `add()` atomic **across** processes | No | **Yes** (`O_EXCL`) | **Yes** (`SET NX`) |
| `increment()` atomic across processes | No | **Yes** (lock file) | **Yes** (`INCRBY`) |
| `Lock` / `WithoutOverlapping` works across processes | No | **Yes** | **Yes** |
| Atomic lock release (`releaseLock()`) | Yes | Yes | Yes (Lua CAS) |
| Eager expiry | Timer, every 60s | `prune()` | Redis's own |
| Values | Live references | JSON | JSON |
| Blast radius of corruption | — | One key | — |

Two caveats on the file store's "yes"es. They rest on `rename()` and
`open(…, "wx")` being atomic, which is true of a **local** filesystem and
historically not of NFS — over a network filesystem, use Redis. And
"across processes" means across processes *on one host*: several machines
sharing a mount is the same NFS problem.

### Serialization differs by store, and it is not abstracted away

| | `array` | `file` / `redis` |
|---|---|---|
| Object, array, string, number, boolean, `null` | as-is | round-trips |
| `Date` | stays a `Date` | comes back a **string** |
| `Map` / `Set` | stays itself | comes back **`{}`** |
| `undefined` object property | kept | **dropped** |
| `BigInt` | kept | **throws** on write |
| Mutating the value after caching | **affects the cached copy** | no effect |

The array store holds a live reference to whatever you passed; the other
two `JSON.stringify` it. So this is a real behaviour change on
`CACHE_STORE=redis`, not a detail:

```ts
await Cache.put("user", { name: "Aroha", lastSeen: new Date() });
const user = await Cache.get<{ lastSeen: Date }>("user");

user.lastSeen.getTime();   // fine on `array`, TypeError on `file`/`redis`
```

The type parameter on `get<T>()` is an assertion, not a check — nothing
validates that what came back matches `T`. There is no tagged serializer
(a `superjson`-style envelope) because it would make every stored value
non-interoperable with anything else reading that Redis. **Cache
JSON-shaped data**, and convert at the boundary:

```ts
await Cache.put("user", { name: user.name, lastSeen: user.lastSeen.toISOString() });
```

## The stores

### `ArrayCacheStore`

A `Map<string, Entry>` in this process's memory. Dies with the process.
Zero configuration, and the default in a new app.

```ts
export function cacheConfig(): CacheConfig {
  return {
    default: "array",
    stores: { array: {}, file: { path: "storage/cache" }, redis: {} },
  };
}
```

Correct for a single process and for tests. Wrong the instant you run two.
See [Redis](../redis/) for what breaks and why.

One option, and you will rarely set it:

```ts
array: { sweepIntervalSeconds: 60 }   // 0 disables the sweep
```

The sweep exists because expiry is otherwise only evaluated on read (see
[TTL](#ttl-is-always-seconds-always-absolute-always-lazy)). Its timer is
`unref()`ed, so it can never be why a CLI command fails to exit.

#### Store atomicity

`increment()` and `add()` on this store do their read and their write in
one **synchronous** block, with no `await` in between:

```ts
async add<T>(key: string, value: T, ttlSeconds?: number): Promise<boolean> {
  if (this.liveEntry(key) !== undefined) return false;
  this.store.set(key, { value, expiresAt: /* ... */ });
  return true;
}
```

JavaScript is single-threaded with run-to-completion
semantics: a synchronous block cannot be interrupted by another `async`
caller's continuation. The moment a function `await`s, its entire
synchronous prefix has already committed.

The naive-looking alternative is **not** atomic:

```ts
// BROKEN — do not implement add() this way
if (await this.has(key)) return false;
await this.put(key, value, ttlSeconds);
return true;
```

Two concurrent callers can both observe "key absent" at the `await`
boundary before either has written, and both return `true`. That is
exactly the bug `Lock.acquire()` depends on not existing — two holders of
a mutual-exclusion lock.

The guarantee is scoped to **one Node process**. Two processes each with
their own `ArrayCacheStore` share nothing at all.

### `FileCacheStore`

**One file per key** under a directory. Durable across restarts, and safe
for several processes on one host to share — which is the combination it
exists for: a web server plus `queue:work` plus a `schedule:run` cron, no
Redis.

```ts
{ default: "file", stores: { file: { path: "storage/cache" } } }
```

**`path` is a directory, not a file.** It was `storage/cache.json` before
this store was one file per key; an app still pointing at a file gets an
error saying so rather than a bare `ENOTDIR`.

```
<path>/ab/cd/abcd…       sha1(key), split into two directory levels
<path>/ab/cd/abcd….lock  transient, only during a read-modify-write
```

Hashing gives a filesystem-safe name for any key (`user:1/profile`, a URL,
a key with `../` in it) and, incidentally, means a key can never escape
the cache directory. The two-level fan-out keeps any one directory small.

Three filesystem primitives do all the work, and none of them is a lock a
process has to remember to drop:

- **`rename()` is atomic.** Every write goes to a temp file in the same
  directory, then renames over the target. A reader sees the whole old
  entry or the whole new one; a crash mid-write leaves the old one intact.
- **`open(path, "wx")` is atomic create-if-absent** — which is exactly
  `add()`'s contract, in one syscall, genuinely exclusive across
  processes.
- **An `O_EXCL` lock file** for the two operations that are unavoidably
  read-modify-write: `increment()`, and the `add()` case where a key
  exists but has expired. Held for microseconds, and reclaimed by the next
  caller if it is older than `STALE_LOCK_MS` (5s) — so a process killed
  while holding one cannot wedge a key permanently.

**Reads never write.** `get()`/`has()` read one file; the only write on the
read path is unlinking an entry that has expired.

Two things this buys that the previous single-`cache.json` implementation
did not have, both of which were real:

- **No lost updates.** That version serialized through an *in-process*
  promise chain, so two processes each did an unsynchronised
  read-modify-write of the whole file and the last writer won. Rate limits
  undercounted, and `add()` returned `true` in two processes at once — so
  `Lock`, `WithoutOverlapping` and `rememberViaLock()` guarded nothing.
- **A corrupt file costs one key, not the cache.** A plain `writeFile()`
  of a single file meant a crash mid-write left truncated JSON, and every
  subsequent read of *every* key threw.

`prune()` (or `./artisan cache:prune`) deletes entries whose TTL has
elapsed, plus any `.tmp`/`.lock` scratch file older than 5 seconds — the
leftovers of a process killed mid-write. Schedule it if you write far more
keys than you read back.

Cross-process guarantees hold on a **local** filesystem. `O_EXCL` and
`rename()` are historically not atomic on NFS; nothing here detects that
for you.

### `RedisCacheStore`

Lives in `@mahiframework/redis`. `increment` maps to `INCRBY`, `add` to
`SET key value NX EX ttl`, and `releaseLock` to a compare-and-delete Lua
script — all genuinely atomic *across processes*, so every `Lock` and
`RateLimiter` built on it becomes multi-process correct for free. Its
keys live under a `cache:` namespace inside the connection's `keyPrefix`,
which is what stops `flush()` reaching the queue. See [Redis](../redis/).

## `CacheManager` and the `Cache` facade

`CacheManager extends Manager<CacheStore>` — the same synchronous,
lazily-resolving, per-name-cached driver resolver as `DatabaseManager`.

| Method | Returns | Notes |
|---|---|---|
| `store(name?)` | `CacheStore` | Alias for `driver()`. Default store if `name` is omitted. |
| `storeConfig(name)` | `unknown` | The raw `stores[name]` config entry. |
| `extend(name, factory)` | `this` | Register a store. How `redis` is added. |
| `remember(key, cb, ttl?, storeName?)` | `Promise<T>` | Delegates after resolving the store. |
| `rememberViaLock(key, cb, ttl?, storeName?)` | `Promise<T>` | Same, stampede-safe. |

The manager's `remember`/`rememberViaLock` take `storeName` as a **fourth**
argument, after `ttlSeconds`, so the first three arguments match
`CacheStore.remember()` exactly.

`CacheServiceProvider` registers `array` and `file` via `extend()` — the
same mechanism a plugin uses — plus the `RateLimiter` singleton at
`RATE_LIMITER_TOKEN`, bound to the app's **default** store. Neither
built-in store implements `Connectable`, so there is no `boot()`.

### The `Cache` facade

```ts
class Cache extends Facade<CacheManager>(() => CACHE_TOKEN)
```

Two groups of statics, and the split matters:

| Forwarded to the **default store** | Forwarded to the **manager** |
|---|---|
| `get`, `put`, `forget`, `has`, `flush`, `increment`, `add`, `lock` | `store`, `remember`, `rememberViaLock` |

```ts
await Cache.put("key", value, 60);           // default store
await Cache.store("redis").put("key", value); // a specific store
await Cache.remember("key", load, 300, "redis");
```

There is no `Cache.put(..., store)` overload. For a non-default store, go
through `Cache.store(name)` — which returns a plain `CacheStore` with the
identical methods.

Prefer injecting `CacheManager` via `CACHE_TOKEN` where you already have
`app` (inside a `ServiceProvider`, a `Command`, a controller that received
it). The facade is for call sites where threading it through is genuinely
inconvenient — same guidance as `app()` itself.

## Locks

A `Lock` is `add()` on a `"<key>_lock"` entry, plus a retry loop and an
owner token.

```ts
import { Cache, LockTimeoutError } from "@mahiframework/cache";

const lock = Cache.lock({
  key: "rebuild-feed",
  automaticReleaseAfterSeconds: 30,
  maximumWaitForSeconds: 5,
});

await lock.acquire();          // throws LockTimeoutError after 5s
try {
  await rebuildFeed();
} finally {
  await lock.release();
}
```

Or, equivalently:

```ts
await lock.get(() => rebuildFeed());
```

### `LockOptions`

| Option | Type | Default | Meaning |
|---|---|---|---|
| `key` | `string` | *(required)* | Suffixed with `_lock` internally. |
| `automaticReleaseAfterSeconds` | `number` | *(required)* | Seconds before the lock self-releases. |
| `maximumWaitForSeconds` | `number` | `Infinity` | Seconds `acquire()` retries before throwing. |
| `retryEvery` | `number` | `250` | **Milliseconds** between retries. |
| `automaticReleaseAfter` | `number` | — | `@deprecated` millisecond spelling. Ignored when the seconds field is set. |
| `maximumWaitFor` | `number` | — | `@deprecated` millisecond spelling. Ignored when the seconds field is set. |

**`automaticReleaseAfterSeconds` is required.** Omitting both it and the
deprecated millisecond alias throws from the constructor:

```
Lock requires an automatic-release TTL: pass `automaticReleaseAfterSeconds` (seconds).
```

There is no default, because there is no safe default. The TTL is the only
thing standing between a crashed holder and a permanently stuck lock, and
its correct value is "somewhat longer than the work takes" — which the
framework cannot know.

**`retryEvery` is in milliseconds while everything else is in seconds.**
It's the retry loop's own unit and never touches a store TTL. Read the
signature.

**`maximumWaitForSeconds: 0` means try once and throw immediately** — the
non-blocking acquire. That's what `WithoutOverlapping` job middleware uses,
so a worker slot is never tied up waiting.

### The three methods

```ts
acquire(): Promise<void>
release(): Promise<void>
get<T>(callback: () => T | Promise<T>): Promise<T>
```

**`acquire()` IS `block()`.** There is no separate non-waiting `get()` and
waiting `block()` pair as in Laravel. One method, which always waits up to
`maximumWaitForSeconds` (default: forever) and always throws
`LockTimeoutError` on timeout rather than returning `false`. Safe to call
again after a timeout — it retries from scratch.

**`release()` is owner-checked, atomically.**

```ts
async release(): Promise<void> {
  if (!this.held) return;
  this.held = false;

  if (this.store.releaseLock) {
    await this.store.releaseLock(this.lockKey, this.owner);
    return;
  }

  const currentOwner = await this.store.get<string>(this.lockKey);
  if (currentOwner === this.owner) await this.store.forget(this.lockKey);
}
```

Each `Lock` instance carries a `randomUUID()` owner token written as the
lock entry's value. If the lock expired and someone else re-acquired it,
`release()` is a safe no-op — it will not delete a lock this instance no
longer owns. You never manage the owner string yourself.

The two branches are not equivalent, and the reason is the whole point of
`CacheStore.releaseLock()`. The fallback is a `get()` and a `forget()`:
two round-trips with a window in between. On a shared store the lock's TTL
can expire *inside* that window, a second holder can acquire it, and the
`forget()` then deletes **their** lock — two live holders of a
mutual-exclusion lock, which is the single failure a lock exists to
prevent. All three built-in stores implement `releaseLock()` (Redis via a
compare-and-delete Lua script, the file store under its entry lock, the
array store synchronously), so the fallback only ever runs for a
third-party store that predates the method.

**`automaticReleaseAfterSeconds` is floored at 1 second.** `Math.ceil(0)`
is `0`, which stores read as "no expiry" — so a lock configured with a
zero TTL would have had no recovery path at all, and a
`WithoutOverlapping({ expireAfterSeconds: 0 })` job would have wedged its
job class forever. Redis rejects `EX 0` outright, so one second — the
shortest lifetime it can express — is the floor everywhere.

**`get(callback)`** acquires, runs, and releases in a `finally` — so a
throwing callback still frees the lock. Returns the callback's value.

**There is no `block()` and no `forceRelease()`.** `acquire()` covers the
first. There is no supported way to steal a lock you don't own; the
auto-release TTL is the recovery mechanism, and if it's wrong the fix is a
better TTL, not a bypass.

### `LockTimeoutError`

```
Timed out waiting to acquire lock "rebuild-feed".
```

Thrown by `acquire()` (and therefore by `get()`) when the wait budget
elapses. `name` is `"LockTimeoutError"`.

### How exclusive is a lock, really?

Exactly as exclusive as the underlying store's `add()`:

| Store | Exclusive within one process | Exclusive across processes |
|---|---|---|
| `ArrayCacheStore` | Yes — synchronous `Map` check-then-set | No — nothing is shared |
| `FileCacheStore` | Yes | **Yes**, on one host — `open(…, "wx")` is an atomic create |
| `RedisCacheStore` | Yes | **Yes**, anywhere — `SET NX` is server-side atomic |

A `WithoutOverlapping` job middleware backed by the **array** store guards
nothing at all once you run two workers. The file store fixes that for
processes on one machine; only Redis fixes it across machines.

## Rate limiting

### `Limit`

A single limit: max attempts within a decay window, optionally scoped to a
key.

```ts
class Limit {
  key: string;
  maxAttempts: number;
  decaySeconds: number;
  afterCallback?: AfterCallback;
  responseCallback?: ResponseCallback;
}
```

| Static | Signature | Produces |
|---|---|---|
| `Limit.perSecond` | `(maxAttempts, decaySeconds = 1)` | `decaySeconds` seconds |
| `Limit.perMinute` | `(maxAttempts, decayMinutes = 1)` | `60 * decayMinutes` |
| `Limit.perMinutes` | **`(decayMinutes, maxAttempts)`** | `60 * decayMinutes` |
| `Limit.perHour` | `(maxAttempts, decayHours = 1)` | `3600 * decayHours` |
| `Limit.perDay` | `(maxAttempts, decayDays = 1)` | `86400 * decayDays` |
| `Limit.none` | `()` | An `Unlimited` |

**`perMinutes()` takes its arguments in the opposite order** — decay first,
then max — matching Laravel's `Limit::perMinutes()`. `Limit.perMinute(5,
2)` and `Limit.perMinutes(2, 5)` are the same limit. Every other static
puts `maxAttempts` first. This is the one place to double-check.

Fluent modifiers:

| Method | Effect |
|---|---|
| `by(key)` | Scope the limit to a signature — a user id, an IP, an API key. |
| `after(callback)` | Only record a hit when `callback(result)` is truthy. |
| `response(callback)` | Build a custom response when exceeded, instead of the default 429. |
| `fallbackKey()` | A key derived from this limit's own attributes. |

`after()` is what "only count failed logins" is made of. In HTTP,
`throttle()` calls it with the `Response` **after** the handler runs, and
only hits the counter when it returns true — a successful login costs
nothing against the limit.

`fallbackKey()` returns `` `${key ? key + ":" : ""}attempts:${maxAttempts}:decay:${decaySeconds}` ``.
It exists so `RateLimiter.limiter()` can disambiguate two limits from the
same named limiter that would otherwise share an empty `.key` and
therefore one counter.

### `GlobalLimit` and `Unlimited`

```ts
class GlobalLimit extends Limit   // constructor(maxAttempts, decaySeconds = 60)
class Unlimited extends GlobalLimit // constructor() — maxAttempts = Number.MAX_SAFE_INTEGER
```

`GlobalLimit` is a limit with no per-key split — every caller shares one
counter ("this endpoint may be called 1000 times/minute in total").

`Unlimited` is a marker. Consumers check `instanceof Unlimited` and skip
rate limiting **entirely**, rather than enforcing a limit of
`MAX_SAFE_INTEGER` (which would still cost a cache round-trip per
request). `Limit.none()` constructs one:

```ts
limiter.for("api", (request: Request) =>
  request.user()?.plan === "enterprise"
    ? Limit.none()
    : Limit.perMinute(60).by(request.user()?.id ?? request.ip() ?? "unknown"),
);
```

All three classes live in one file, deliberately: `Limit.none()`
constructs an `Unlimited`, which extends `GlobalLimit`, which extends
`Limit`. ESM `extends` requires the base binding to be fully evaluated, so
splitting them across mutually-importing modules would throw at
module-load time. `index.ts` re-exports all three regardless.

### `RateLimiter`

Bound as a singleton at `RATE_LIMITER_TOKEN` by `CacheServiceProvider`,
backed by the app's **default** cache store. That's the same token
`@mahiframework/http`'s `throttle()` resolves, and it's why
`CacheServiceProvider` must be listed before `HttpServiceProvider`.

Because it's built on the default store, `cache.default` decides whether
your rate limits are per-process or shared. Three processes on the `array`
store means "5 per minute" is really "15 per minute".

| Method | Signature | Notes |
|---|---|---|
| `for` | `(name, callback) => this` | Register a named limiter. |
| `limiter` | `(name) => ((...args) => Promise<Limit[]>) \| undefined` | Resolve one. `undefined` if unregistered. |
| `attempt` | `(key, maxAttempts, callback, decaySeconds = 60)` | Run `callback` unless limited. |
| `tooManyAttempts` | `(key, maxAttempts) => Promise<boolean>` | |
| `hit` | `(key, decaySeconds = 60) => Promise<number>` | `increment(key, decaySeconds, 1)`. |
| `increment` | `(key, decaySeconds = 60, amount = 1)` | |
| `decrement` | `(key, decaySeconds = 60, amount = 1)` | `increment` with `amount * -1`. |
| `attempts` | `(key) => Promise<number>` | `0` when absent. |
| `resetAttempts` | `(key) => Promise<void>` | Clears the counter, **not** the timer. |
| `remaining` | `(key, maxAttempts) => Promise<number>` | Floored at `0`. |
| `retriesLeft` | `(key, maxAttempts)` | Alias for `remaining`. |
| `clear` | `(key) => Promise<void>` | Clears counter **and** timer. |
| `availableIn` | `(key) => Promise<number>` | Seconds until the window resets. |

#### The two-key layout

Every rate-limited key uses **two** cache entries:

| Key | Value | Set by |
|---|---|---|
| `key` | the hit count | `add(key, 0, decay)` then `increment(key, amount)` |
| `key + ":timer"` | the epoch-seconds timestamp the window resets at | `add(key + ":timer", availableAt, decay)` |

```ts
async increment(key: string, decaySeconds = 60, amount = 1): Promise<number> {
  await this.cache.add(`${key}:timer`, this.availableAt(decaySeconds), decaySeconds);
  const added = await this.cache.add(key, 0, decaySeconds);
  const hits = await this.cache.increment(key, amount);
  if (!added && hits === amount) {
    await this.cache.put(key, amount, decaySeconds);
  }
  return hits;
}
```

The timer is seeded with `add()`, so the **first** hit in a fresh window
wins and every subsequent hit leaves it alone. Combined with
`increment()`'s expiry-preserving semantics, the window is a genuine fixed
window: it starts on the first hit and ends `decaySeconds` later,
regardless of traffic in between.

`tooManyAttempts()` reads both:

```ts
if ((await this.attempts(key)) >= maxAttempts) {
  if (await this.cache.has(`${key}:timer`)) return true;
  await this.resetAttempts(key);
}
return false;
```

At-or-over the limit **and** the timer still live means blocked. At the
limit with a dead timer means the window rolled over — reset the counter
and allow. This is why `resetAttempts()` (counter only) and `clear()`
(both) are separate methods: clearing only the counter is precisely what
window rollover needs.

`availableIn()` reads the timer and subtracts now:

```ts
const availableAt = (await this.cache.get<number>(`${key}:timer`)) ?? 0;
return Math.max(0, availableAt - this.currentTime());
```

It returns `0` for a key that was never hit, which is correct ("available
now") but indistinguishable from "the window just ended". It's what
`throttle()` puts in the `Retry-After` header and what `RateLimited` job
middleware uses as its release delay.

#### Manual use

```ts
const limiter = app.make<RateLimiter>(RATE_LIMITER_TOKEN);

if (await limiter.tooManyAttempts(`imports:${user.id}`, 3)) {
  const seconds = await limiter.availableIn(`imports:${user.id}`);
  throw new Error(`Too many imports. Try again in ${seconds}s.`);
}
await limiter.hit(`imports:${user.id}`, 3600);
```

Or `attempt()`, which folds the check, the run, and the hit together:

```ts
const result = await limiter.attempt(`imports:${user.id}`, 3, () => runImport(), 3600);
if (result === false) { /* rate limited — the import did not run */ }
```

`attempt()` returns `false` when limited, otherwise the callback's return
value — or `true` if the callback returned `undefined`/`null`, so a
void-returning callback can still signal "it ran".

#### Named limiters

`for(name, callback)` registers a reusable configuration. The callback
receives whatever the consumer passes at the call site and returns one
`Limit` or an array of them.

```ts
// app/src/providers/users.provider.ts
export class UsersServiceProvider extends ServiceProvider {
  boot(): void {
    const limiter = this.app.make<RateLimiter>(RATE_LIMITER_TOKEN);

    limiter.for("login", async (request: Request) => Limit.perMinute(5).by(await loginKey(request)));
    limiter.for("register", (request: Request) => Limit.perMinute(10).by(clientIp(request)));
  }
}
```

That login key is `email|ip`, not one or the other, and the reason is worth
copying. Keying on IP alone lets an attacker spread guesses for one account
across many addresses. Keying on email alone lets an attacker lock a victim
out of their own account by deliberately burning the limit. Combining them
bounds both.

Stacked limits are just an array:

```ts
limiter.for("api", (request: Request) => [
  Limit.perMinute(60).by(request.user()!.id),
  Limit.perDay(10_000).by(request.user()!.id),
]);
```

`limiter(name)` returns a resolver that runs the callback, normalises the
result to an array, and rewrites any **duplicated** `.key` to that limit's
`fallbackKey()` — so two `Limit.perMinute()` calls with no explicit
`.by()` don't silently share one counter. Limits with distinct keys are
left untouched.

In HTTP, `throttle("login")` is the consumer. See
[Routing](../routing/) and [Requests](../requests/).

```ts
router.post("/auth/login", LoginController).middleware(throttle("login"));
```

`throttle()` additionally prefixes every key with `throttle:{name}:`, so
HTTP limits can't collide with a manually-managed limiter key.

## Testing

`ArrayCacheStore` is already the test-friendly one — no infrastructure, no
cleanup beyond a fresh instance per test, and it's what a generated app's
`cache.default` points at. There is no cache fake because there doesn't
need to be one.

Time-dependent assertions are the awkward part: TTLs are compared against
`Date.now()` on read, so a test for expiry either waits or fakes the clock.

```ts
const store = new ArrayCacheStore();
await store.put("key", "value", 60);
expect(await store.get("key")).toBe("value");
```

## Gotchas

**`undefined` is the only miss.** `remember()` will happily cache `null`
and return it forever. A loader that returns `undefined` for "not found"
re-runs on every call.

**`increment()` on a fresh key has no expiry.** Seed with
`add(key, 0, ttl)` first, exactly as `RateLimiter` does, or you get an
immortal counter.

**`Cache.flush()` hits the default store only.** So does
`Cache.get`/`put`/`forget`. Non-default stores are untouched — which is
also why `./artisan cache:clear` on the default `array` store clears that
CLI process's own empty `Map` and reports success. Pass `--store`.

**`RedisCacheStore.flush()` is namespace-scoped, never `FLUSHDB`.** It
scans `<connection keyPrefix>cache:*`, so it cannot reach the queue's
`queues:*` keys or a co-tenant's. See [Redis](../redis/).

**`FileCacheStore` doesn't shrink on its own.** Expired entries are
removed when read, or by `prune()` / `./artisan cache:prune`. `flush()`
deletes everything.

**Cache JSON-shaped values.** A `Date` comes back a string and a `Map`
comes back `{}` on `file`/`redis`, but survive intact on `array` — so a
bug here only shows up after you switch `CACHE_STORE`. See
[Serialization](#serialization-differs-by-store-and-it-is-not-abstracted-away).

**Locks are per-store.** `Cache.store("array").lock({...})` and
`Cache.store("redis").lock({...})` with the same key are two unrelated
locks.

**A lock's auto-release TTL is a deadline, not a lease renewal.** Work
that outruns `automaticReleaseAfterSeconds` loses the lock mid-flight, and
a second holder can start. There is no keep-alive; size the TTL for the
worst case.

## Related

- [Queues](../queues/) — `RateLimited`, `WithoutOverlapping` and
  `ThrottlesExceptions` job middleware are all built on this package
- [Redis](../redis/) — the multi-process store, and why the built-ins
  aren't
- [Configuration](../configuration/) — `config/cache.ts`
- [Providers](../providers/) — registering a custom store via `extend()`
- [Routing](../routing/) — `throttle()` middleware
