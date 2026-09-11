# Redis

`@mahi/redis` is one shared connection and three thin driver adapters:
a `CacheStore`, a `QueueDriver`, and a `BroadcastDriver`. It is the
framework's answer to "we now run more than one Node process."

```ts
// config/app.ts — after Cache/Queue/Broadcast providers
RedisServiceProvider,
```

```ts
// config/cache.ts
{ default: "redis", stores: { array: {}, file: { path: "storage/cache" }, redis: {} } }
```

That's the whole migration. No call site changes, because every consumer
already talks to the `CacheStore` / `QueueDriver` / `BroadcastDriver`
interface rather than to a specific implementation.

## The multi-process problem

Three of the framework's defaults are single-process-only. Not as a
caveat — as their defining limit.

### `array` cache: nothing is shared

`ArrayCacheStore` is a `Map` in one process's memory. Two processes have
two Maps and share nothing. Concretely:

- **Rate limits multiply.** `Limit.perMinute(5)` across three processes is
  really 15 per minute, because each process counts independently. Whether
  a request is throttled depends on which process the load balancer picked.
- **`Cache.remember()` computes N times**, once per process.
- **`Cache.forget()` clears one process.** The other two keep serving the
  stale value until their own TTLs expire.
- **`Cache.lock()` guarantees nothing.** Each process's `add()` is atomic
  within itself and invisible to the others, so two processes both acquire
  "the" lock. That takes `WithoutOverlapping` job middleware and
  `rememberViaLock()` with it.

`FileCacheStore` fixes both of those *for processes on one host* — its
`add()` is an atomic `O_EXCL` create and its `increment()` runs under a
lock file, so locks and rate limits are genuinely shared between a web
server and a worker on the same machine. What it cannot do is span
machines, and its guarantees rest on `rename()`/`O_EXCL` being atomic,
which is true locally and not over NFS.

### `sync` queue: no worker, no isolation

`SyncQueueDriver` runs the job inside the request that dispatched it. That
isn't a scaling problem so much as an architecture one: the work isn't
deferred, doesn't retry, doesn't survive a crash, and adds its whole
runtime to your response time. The `database` driver is multi-process-safe
(see [Queues](../queues/#database)), so this is the one place Redis is a
throughput improvement rather than a correctness fix.

### `local` broadcast: the silent one

This is the worst of the three, because nothing errors.

`LocalBroadcastDriver` keeps its `channel → sockets` map in one process's
memory. With two or more server processes, a broadcast from process A
**silently never reaches** a client whose websocket landed on process B.
No exception, no warning, no log line — the message just doesn't arrive.
You discover it in production, intermittently, as "notifications sometimes
don't show up."

`RedisBroadcastDriver` is the fix, and it's the reason this package
exists.

### What Redis changes

| | Single-process default | With Redis |
|---|---|---|
| Cache reads/writes | per-process `Map` | one shared keyspace |
| `increment()` | atomic in-process | `INCRBY` — atomic server-side |
| `add()` / `Lock` | atomic in-process | `SET NX` — genuinely exclusive across processes |
| `RateLimiter` | counts per process | one counter |
| Broadcast fanout | this process's sockets only | every process, via pub/sub |
| Queue | `sync` inline, or `database` | Redis lists |

The cache correctness wins are free. `RedisCacheStore.increment` maps to
`INCRBY` and `add` to `SET key value NX EX ttl` — both single, atomic
server-side commands — so every `Lock` and `RateLimiter` built on that
store becomes multi-process correct without any code above it changing.
See [Cache](../cache/).

## `RedisConnection`

One logical connection: a shared command client plus, lazily, dedicated
clients for the two modes Redis won't let a shared client be in.

```ts
const connection = redis.connection();       // the default
connection.client();                          // the shared command client
connection.duplicate();                       // a new client, same options, tracked
```

### `client()` vs `duplicate()` — the Redis constraint

Redis puts a connection into modes where it can no longer serve ordinary
commands. Two of them matter:

**Subscriber mode.** After `SUBSCRIBE`, a connection may only run
subscribe/unsubscribe/ping commands until it unsubscribes. A `GET` on that
socket is an error. So `RedisBroadcastDriver` takes its own subscriber via
`duplicate()`, and the shared client stays free to `PUBLISH`.

**Blocking commands.** `BRPOP` monopolises its connection for the entire
block — every other command queued behind it waits. A worker blocking for
five seconds on a pop would stall every cache read sharing that socket.

Everything else — `GET`, `SET`, `INCR`, `PUBLISH`, `LPUSH`, `LREM`,
`SCAN`, `EVAL` — is non-blocking and non-subscribed, so it all shares the
single `client()`. That's the whole rule: **one client for normal
commands, a duplicate for anything that takes the socket hostage.**

`duplicate()` copies the same options and **tracks** the new client, so
`disconnect()` tears it down too. Don't build clients with `new Redis()`
yourself unless you're also closing them — an untracked open socket is
exactly what keeps a process from exiting.

### Lazy connection

```ts
this.primary = new Redis(this.options);   // options include lazyConnect: true
```

`lazyConnect` keeps the constructor from opening a socket. Resolution
stays synchronous — constructing a driver handle is cheap, per the
framework's manager contract — and real I/O waits for `connect()`, exactly
as `SqliteDriver` defers its own.

`RedisConnection implements Connectable`, so its owning provider connects
it explicitly in `boot()`:

```ts
async connect(): Promise<void> {
  await ignoreAlreadyConnected(this.primary.connect());
}
```

A double-`connect()` is a deliberate no-op. ioredis throws "Redis is
already connecting/connected", which is caught and ignored, so two
providers sharing one connection is harmless.

`disconnect()` `quit()`s every client it handed out (flushing pending
commands first), falling back to a hard `disconnect()` for a client that
never connected — `quit()` on an unconnected client would hang. Shutdown
is best-effort and never throws; the process is going down anyway, and a
failed quit shouldn't mask the real exit reason.

## `RedisManager`

`RedisManager extends Manager<RedisConnection>` — the same synchronous,
per-name-cached resolver as every other manager.

| Method | Purpose |
|---|---|
| `connection(name?)` | Alias for `driver()`. Default if omitted. |
| `connectionConfig(name)` | The config entry, or `{}`. |
| `connectionNames()` | Every config-declared connection name. |
| `extend(name, factory)` | Register a connection. |

`RedisServiceProvider.register()` calls `extend()` for every name in
`connectionNames()`, so declaring a connection in config is all it takes
to make it resolvable.

**One resolved connection is shared by all three drivers** that point at
the same connection name. That's the design: a single client, three thin
adapters — not three sockets doing the same thing.

## Configuration

```ts
export function redisConfig(env: Env): RedisConfig {
  return {
    default: "default",
    connections: {
      default: {
        url: env.REDIS_URL,
        host: env.REDIS_HOST,
        port: env.REDIS_PORT,
        password: env.REDIS_PASSWORD,
        keyPrefix: "mahi:",
      },
    },
  };
}
```

| Field | Meaning |
|---|---|
| `url` | `redis://[user:pass@]host:port[/db]`, or `rediss://` for TLS. **Wins over the discrete fields.** |
| `host` / `port` / `username` / `password` / `db` | The discrete form. |
| `keyPrefix` | Applied by ioredis to every key on this connection. |
| `options` | Straight through to ioredis — `tls`, `sentinels`, `retryStrategy`, anything not modelled here. |

`url` is parsed into host/port/username/password/db, and `rediss:` sets
`tls: {}`. `keyPrefix` is applied regardless of which form you used.
`options` is spread in **first**, so the explicit fields win over anything
you put there.

### Two prefixes, and what each one protects

Every key the cache store writes is stored at:

```
<connection keyPrefix><store prefix><key>
mahi:                  cache:        feed:global
```

| | Set in | Default | Protects against |
|---|---|---|---|
| **Connection** `keyPrefix` | `config/redis.ts` | none — **set one** | Another *application* on the same Redis |
| **Store** `prefix` | `config/cache.ts`, `stores.redis.prefix` | `"cache:"` | The *queue* (and anything else) on the same connection |

Both matter, and the second one is not cosmetic.

`RedisCacheStore.flush()` is deliberately **not** `FLUSHDB`, which would
nuke every other application sharing that instance or logical DB. It scans
with `SCAN` (cursor-based and non-blocking, unlike `KEYS`) and deletes
each batch with `UNLINK` (frees memory on a background thread rather than
stalling the server):

```ts
async flush(): Promise<void> {
  const pattern = `${this.connectionPrefix}${this.prefix}*`;   // "mahi:cache:*"
  let cursor = "0";
  do {
    const [next, keys] = await this.client.scan(cursor, "MATCH", pattern, "COUNT", 100);
    cursor = next;
    if (keys.length > 0) {
      await this.client.unlink(...keys.map((key) => this.stripConnectionPrefix(key)));
    }
  } while (cursor !== "0");
}
```

`RedisQueueDriver` writes `queues:default`, `queues:default:reserved` and
friends on the **same connection under the same `keyPrefix`**. A `flush()`
scoped to the connection prefix alone would match every one of them — so
`./artisan cache:clear` would delete every queued and every in-flight job.
Scoping cache keys under their own `cache:` segment makes that
intersection impossible by construction rather than by convention.

Note the prefix handling, which is the one place ioredis's automatic
prefixing has to be undone by hand. `SCAN`'s `MATCH` is matched against
the *actual stored key* and is not auto-prefixed, so the pattern is built
fully-qualified; the keys it returns are likewise fully-qualified, so the
connection prefix is stripped back off before `UNLINK` or ioredis would
apply it a second time.

> **Why the connection prefix is read off the live client, not config.**
> A separately-configured copy that goes unset yields `""`: `flush()`
> then scans `MATCH *` (the whole DB, queue included) and `DEL`s each
> match with the connection prefix applied twice — matching everything and
> deleting nothing, so `cache:clear` silently does nothing. Dropping the
> connection prefix from the `DEL` instead turns it into a command that
> wipes the queue. Deriving both halves from the client's real `keyPrefix`
> is what rules out either failure.

### Cache / queue / broadcast entries

Each of the three subsystems has its own small config block naming which
Redis connection it uses:

```ts
// config/cache.ts        stores.redis
{ connection?: string; prefix?: string }        // prefix defaults to "cache:"

// config/queue.ts        connections.redis
{ connection?: string; queue?: string }         // queue defaults to "default"

// config/broadcasting.ts connections.redis
{ connection?: string; channel?: string; path?: string }
```

`connection` omitted means "the `default` connection from
`config/redis.ts`". An empty `{}` is a valid, complete config — and the
right one. Change `prefix` only to run two independent caches on one
connection; setting it to `""` re-opens the "flush can reach the queue"
hazard.

## `RedisServiceProvider`

```ts
register(): void {
  this.app.singleton(REDIS_TOKEN, (app) => { /* build the manager, extend() each connection */ });
  this.extendCache();
  this.extendQueue();
  this.extendBroadcast();
}
```

Each `extend*()` is guarded by `this.app.has(TOKEN)` — an app without the
queue package simply doesn't get a `redis` queue connection, with no
error.

### Provider ordering

List it **after** `CacheServiceProvider`, `QueueServiceProvider` and
`BroadcastServiceProvider`. All three are hard requirements: `register()`
resolves each of those managers' tokens to call `extend()` on them, so the
tokens must already be bound.

Since `register()` runs before *any* provider's `boot()`, `"redis"` is a
valid `default` for broadcasting even though `BroadcastServiceProvider.boot()`
mounts the websocket route — by the time any `boot()` runs, the driver has
been registered. See [Providers](../providers/).

### `boot()` only connects when Redis is actually selected

This is the most important behaviour in the package.

```ts
async boot(): Promise<void> {
  if (!this.redisIsSelected()) return;

  const redis = this.app.make<RedisManager>(REDIS_TOKEN);
  const connection = redis.connection();
  if (isConnectable(connection)) await connection.connect();

  if (this.app.has(BROADCAST_TOKEN)) {
    const broadcaster = this.app.make<BroadcastManager>(BROADCAST_TOKEN);
    const driver = broadcaster.connection();
    if (driver instanceof RedisBroadcastDriver) await driver.connect();
  }
}
```

```ts
private redisIsSelected(): boolean {
  return (
    this.app.config.get<string>("cache.default") === "redis" ||
    this.app.config.get<string>("queue.default") === "redis" ||
    this.app.config.get<string>("broadcasting.default") === "redis"
  );
}
```

**Listing the provider costs nothing.** No socket, no connection attempt,
no failure if Redis isn't running. Merely registering `redis` drivers is
free; they're only *resolved* when config points something at them.

This was a real bug, recently fixed. `boot()` used to connect
unconditionally, which contradicted the provider's own documented
contract and had a very concrete cost:

**An open ioredis socket keeps the Node event loop alive.** Every
short-lived process that boots the application — `./artisan migrate`,
`./artisan key:generate`, any CLI command, a `vitest` run — would finish
its work and then **hang**, never exiting, because there was still a live
handle. The base app lists `RedisServiceProvider` by default precisely so
that switching to Redis is a config change rather than a code change,
which made "listed but unused" the *common* case, not the rare one.

Two details of the fix worth knowing:

**It's a config read, not a driver resolution.** Calling
`cacheManager.driver()` to ask "is the default redis?" would *construct*
(and cache) a store on every boot just to answer a question. Reading
`cache.default` from config costs nothing.

**It only checks the three `default`s.** An app that keeps `cache.default`
at `"array"` but resolves `cache.store("redis")` by explicit name does
**not** get a connection from `boot()`. That's fine — the connection
connects lazily through that driver's own code path the first time it's
used, exactly as an extra named connection already does. But it means the
first command on such a store pays the connect latency, and a connection
failure surfaces there rather than at boot.

If you need an eagerly-connected named connection, connect it yourself in
your own provider's `boot()`:

```ts
async boot(): Promise<void> {
  const redis = this.app.make<RedisManager>(REDIS_TOKEN);
  await redis.connection("analytics").connect();
}
```

## The three drivers

### `RedisCacheStore`

A full `CacheStore`. Values are `JSON.stringify`'d in and `JSON.parse`'d
out, so anything structured round-trips, and `undefined` (never a stored
value) stays the miss sentinel — matching `ArrayCacheStore`.

| Method | Redis command | Note |
|---|---|---|
| `get` | `GET` | `null` → `undefined` |
| `put` | `SET` / `SET … EX n` | |
| `forget` | `DEL` | |
| `has` | `EXISTS` | |
| `flush` | `SCAN` + `UNLINK` | Namespace-scoped. See above. |
| `increment` | `INCRBY` | Atomic. **Preserves the existing TTL.** Rejects a non-numeric value. |
| `add` | `SET … NX [EX n]` | Atomic. `true` iff this call set the key. |
| `releaseLock` | `EVAL` (compare-and-delete) | Atomic. What `Lock.release()` uses. |
| `remember` / `rememberViaLock` / `lock` | — | Delegated to the shared helpers exported by `@mahi/cache`. |

`releaseLock()` is the one worth understanding. The portable release is a
`GET` then a `DEL` — two round-trips with a window between them, in which
the lock's TTL can expire and another process can legitimately acquire it;
the first holder's `DEL` then deletes *their* lock. The Lua script
compares and deletes without interleaving, which is the only way that
window closes. See [Cache](../cache/#the-three-methods).

`increment()` preserving the key's expiry is what `RateLimiter` depends
on, and Redis gives it for free — `INCRBY` doesn't touch a key's TTL. See
[Cache](../cache/#increment-preserves-the-existing-expiry).

The counter is stored as a **bare integer string**, not JSON, so `INCRBY`
can operate on it directly. A key written by `increment()` and read by
`get()` parses fine (`JSON.parse("3")` is `3`), but don't mix `put()` of a
non-numeric value and `increment()` on the same key.

TTLs are rounded up to whole seconds with a floor of 1 (`Math.max(1,
Math.ceil(ttlSeconds))`), because Redis `EX` takes whole seconds and
rejects `0`. A sub-second TTL becomes one second rather than an error.

`remember`/`rememberViaLock`/`lock` are one-line delegations to the
`remember`, `rememberViaLock` and `lock` helpers that `@mahi/cache`
exports for exactly this purpose — an out-of-package store gets them by
delegating rather than re-deriving the logic, identically to the built-in
array and file stores.

### `RedisQueueDriver`

A reserve-then-ack driver, faithful to `DatabaseQueueDriver`'s model
rather than a fire-and-forget `RPOP`. Four keys per named queue:

| Key | Type | Contents |
|---|---|---|
| `queues:{q}` | list | Ready jobs. `LPUSH` at the head, reserved from the tail → FIFO. |
| `queues:{q}:delayed` | sorted set | Not-yet-available jobs, scored by availability timestamp (ms). |
| `queues:{q}:reserved` | sorted set | In-flight jobs, scored by **reservation expiry** (ms). |
| `queues:{q}:failed` | hash | Failed jobs, by id. |

The `{q}` braces are a Redis Cluster **hash tag**, not decoration. Every
Lua script here touches two keys at once, and Cluster rejects a multi-key
command whose keys hash to different slots — without the tag these
scripts work against a single node in development and fail on the first
day against a cluster.

#### `pop()`

Three steps, each a single atomic script:

1. **Migrate due delayed jobs** onto the ready list (`ZRANGEBYSCORE` +
   `ZREM` + `LPUSH` in one round-trip, so two workers can't both migrate
   the same job).
2. **Reclaim expired reservations** — every member of the reserved zset
   whose score (reserved-at + `retryAfter`) has passed goes back onto the
   ready list with `attempts` incremented. This is the crash recovery:
   without it, a worker killed mid-job strands its job in `:reserved`
   forever.
3. **Reserve** — `RPOP` the oldest ready job and `ZADD` it to the reserved
   set scored by its expiry, in one script. As two client commands, a
   worker dying in between would lose the job outright.

The reserved set is a **sorted set scored by expiry** precisely so step 2
is a range query. A list can't express expiry, so nothing could reap it.

The exact reserved payload string is stashed on the returned job under a
`Symbol` key, so `delete`/`release`/`fail` can remove it **byte-for-byte**
without depending on a re-serialization producing an identical string. The
symbol key means it never leaks into a payload or a `JSON.stringify`.

`release()`, `fail()` and `retry()` are likewise one script each, for the
same reason: `LREM` then `LPUSH` from the client loses the job if the
worker dies between the two.

Scripts are loaded once and invoked by **`EVALSHA`**, with a transparent
reload on `NOSCRIPT` (a server restart or `SCRIPT FLUSH`). `EVAL` would
ship the whole script body on every poll of every worker.

`pop()` is **non-blocking**, deliberately — the `queue:work` loop already
sleeps when `pop()` returns `undefined`, and a `BRPOP` would tie up a
whole connection (see [`duplicate()`](#client-vs-duplicate--the-redis-constraint)).

`size()` returns `LLEN` of the ready list; `clear(queue)` deletes the
ready and delayed keys (`queue:clear`).

**At-least-once, same as the database driver:** a job whose worker merely
stalls past `retryAfter` is reclaimed and runs again, concurrently with
the original. Make `handle()` idempotent. See [Queues](../queues/).

#### Failed jobs

This driver **implements `FailedJobRepository`**, so `queue:failed`,
`queue:retry`, `queue:forget` and `queue:flush` all work against it. Each
record keeps the full stack trace, the originating queue and the chain, so
a retry puts the job back exactly where it came from with the work queued
behind it intact.

The one thing `database` still has that this doesn't is `afterCommit`
deferral — there is no database transaction here to observe. Dispatch a
job that reads rows written by the transaction dispatching it on the
`database` connection, or accept the race.

### `RedisBroadcastDriver`

`extends LocalBroadcastDriver`, keeping everything it already does — the
websocket upgrade endpoint, the in-memory `channel → sockets` map for
*this* process's clients — and adding one thing: fanout through Redis
pub/sub.

The flow is deliberately uniform across processes:

1. `broadcast(msg)` does **not** touch local sockets. It `PUBLISH`es to a
   shared channel (default `mahi:broadcast`, prefixed by the connection's
   `keyPrefix` — see below).
2. Every process — **including the publisher** — runs a dedicated
   subscriber `SUBSCRIBE`d to that channel. On each message it calls the
   inherited `LocalBroadcastDriver.broadcast()` to deliver to its own
   sockets.

So a broadcast reaches exactly the sockets subscribed to that channel, no
matter which process they connected to, and no process ever tries to
deliver to sockets it doesn't own. The publisher going through Redis to
reach its own clients looks like a detour; it's what makes the path
identical everywhere and removes the "did this one come from local or
remote" branch entirely.

`instanceof LocalBroadcastDriver` still holds, so
`BroadcastServiceProvider` mounts the websocket route and calls
`injectWebSocket()` exactly as for the local driver. **No entrypoint
change is needed to switch from `local` to `redis`** — the socket path
stays whatever you configured.

The subscriber is a `duplicate()` (subscriber mode, see above), connected
and subscribed in `connect()`, which is idempotent. Incoming messages are
delivered fire-and-forget (`void this.deliverLocally(message).catch(log)`)
so a slow or dead socket can't stall the message pump for everyone else.
The `.catch()` is not decoration: an unhandled promise rejection
terminates the process on Node by default, so one throwing socket would
have taken the whole server down rather than dropping one message.
Malformed JSON, or a message missing `channel`/`event`, is dropped
silently.

**The channel name is prefixed with the connection's `keyPrefix`.**
ioredis does not do this for you — it prefixes command *keys*, and a
pub/sub channel is not a key. Without it, two applications correctly
isolated for cache and queue by their differing prefixes still shared the
one `mahi:broadcast` channel, and each one's events were delivered to the
other's websocket clients: a cross-tenant leak that no amount of key
namespacing catches, because the channel was the one name nothing
namespaced.

**Publishing before the subscriber is connected loses the message.**
That's why `RedisServiceProvider.boot()` connects the driver before the
server starts accepting traffic — and why `boot()` checks
`broadcasting.default === "redis"` specifically.

## Deploying

```bash
# .env
REDIS_URL=rediss://:password@redis.internal:6379/0
```

```ts
// config/cache.ts
default: "redis"
// config/broadcasting.ts
default: "redis"
// config/queue.ts
default: "database"     // or "redis" for throughput; database keeps the CLI tooling
```

A reasonable target state for a horizontally-scaled app:

| Subsystem | Setting | Why |
|---|---|---|
| Cache | `redis` | Shared counters, shared locks, one rate-limit budget. |
| Broadcasting | `redis` | The silent-message-loss fix. Non-negotiable past one process. |
| Queue | `database` | Multi-process-safe already, and keeps `queue:failed`/`queue:retry`. |

Switching cache to `redis` also moves the `RateLimiter` — it's bound to
the app's **default** store — so your HTTP throttles become global rather
than per-process. That's usually the point, but it means limits that were
effectively N× looser suddenly aren't. Check your numbers.

Everything else stays the same. Workers still run `./artisan queue:work`,
the scheduler still runs `./artisan schedule:run` from one host's crontab
(that lock is a file, not a Redis key — see
[Scheduling](../scheduling/#schedulelock)).

## Testing

Test against a real Redis. There is no faithful in-memory substitute for
pub/sub across connections, or for `SET NX`/`INCRBY`/`EVAL` atomicity, and
those are the behaviours worth covering.

Give each test a randomised `mahi-test:<random>:` prefix and delete its
own keys by prefix afterwards. Prefer that to `FLUSHDB`, which empties the
whole logical DB — fine against a throwaway container, destructive against
a shared one, and exactly the behaviour `flush()` goes out of its way not
to have.

Two connections that must behave as *two processes of one application*
have to share a prefix, since the broadcast channel is prefixed too;
distinct prefixes model two different applications, which correctly do not
see each other at all.

For application tests, keep `array`/`sync`/`local` — they're faster, need
no infrastructure, and `createTestApplication()` defaults to them. Test
Redis behaviour where it actually differs (cross-process locking,
broadcast fanout), not everywhere.

## Gotchas

**Set a connection `keyPrefix`.** It is what separates your application
from every other one on a shared Redis. The store's own `cache:` prefix
separates the cache from the queue *within* your application; it is not a
substitute.

**Don't set `stores.redis.prefix` to `""`.** That merges the cache's
namespace back into the connection's, and `cache:clear` can then reach
`queues:*`.

**`RedisServiceProvider.boot()` only connects when `cache.default`,
`queue.default` or `broadcasting.default` is `"redis"`.** A store resolved
by explicit name connects lazily instead — its first command pays the
latency, and connection failures surface there.

**An open socket keeps the process alive.** That's why the conditional
connect exists. If you open your own client with `new Redis()`, you own
closing it.

**Use `duplicate()` for subscribers and blocking commands.** A subscribed
client can't serve `GET`; a blocking command stalls everything behind it.

**`RedisQueueDriver` cannot defer a dispatch until a transaction commits.**
There is no database transaction for it to observe, so `{ afterCommit:
true }` pushes immediately. Use the `database` connection for jobs that
read rows written by the transaction that dispatched them.

**A stalled worker's job gets reclaimed and runs twice.** `retryAfter`
(default 90s) is what rescues a *crashed* worker's job; it cannot tell
"crashed" from "slow". Keep it above your worst-case runtime and make
`handle()` idempotent.

**Publishing before the subscriber connects loses the message.** Let the
provider's `boot()` do the connecting.

**Switching `cache.default` to `redis` moves the rate limiter with it.**
Per-process limits become global.

**`url` beats the discrete `host`/`port` fields.** Setting both is not an
error; `url` just wins.

## Related

- [Cache](../cache/) — the `CacheStore` contract, `Lock`, `RateLimiter`
- [Queues](../queues/) — drivers, workers, failed-job commands
- [Broadcasting](../broadcasting/) — `ShouldBroadcast`, the websocket endpoint
- [Configuration](../configuration/) — `config/redis.ts` and the three driver blocks
- [Providers](../providers/) — ordering constraints and `Connectable`
- [Deployment](../deployment/) — running multiple processes
