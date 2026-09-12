# Deployment

A Mahi application in production is a compiled `dist/` directory, a Node
process running `bin/server.js`, and — depending on what you use — a
queue worker and a cron entry.

```bash
npm ci --omit=dev
npm run build              # tsc -b
NODE_ENV=production node dist/bin/server.js
```

This page covers what changes between `./artisan serve` on a laptop and
that command on a server: what to build, what must be in the environment,
what breaks the moment you run two processes, and how to run the workers
and the scheduler alongside the web process.

## Building

The template's `tsconfig.json` compiles `bin`, `config`, `src`, and
`database` into `dist/`, preserving the directory structure:

```jsonc
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["bin", "config", "src", "database"]
}
```

```bash
npm run build      # tsc -b
npm start          # node dist/bin/server.js
```

Both scripts are already in the generated `package.json`. `tsc -b` is
incremental — it writes a `.tsbuildinfo` and skips unchanged projects — so
a CI cache on that file speeds up repeat builds. It is also a real
typecheck: `npm run build` failing is your first line of defence, and
`npm run typecheck` is the same command.

`database/` is compiled deliberately. Migrations and seeders are TypeScript
modules loaded at runtime by `MigrationRunner`, so they must exist as
`.js` in `dist/` for `./artisan migrate` to find them on a server without
`tsx`. The template's `config/database.ts` resolves `migrationsPath`
relative to the running file (`import.meta.dirname`), not the working
directory — so `node dist/bin/console.js migrate` loads
`dist/database/migrations/*.js` automatically, on any Node, whether or not
it strips types. The migrator prefers a compiled `.js` over a `.ts` sibling
and warns loudly if it ever discovers a `.ts` migration under a compiled
entrypoint (the tell-tale of a deploy that shipped source or mis-pointed
`migrationsPath`).

**There is no `tsx` in production.** `./artisan` shells out to `tsx` to run
`bin/console.ts` directly, which is right for development and wrong for a
server — it transpiles on every invocation and pulls a dev dependency into
the runtime image. In production, run the compiled console entry instead:

```bash
node dist/bin/console.js migrate
node dist/bin/console.js queue:work
```

Everything `./artisan <command>` does, `node dist/bin/console.js <command>`
does, because `./artisan` is a shell wrapper around exactly that file.

### The entrypoint

```ts
// bin/server.ts
import { trap } from "@mahiframework/cli";
import { formatServeUrl, listenHttpServer } from "@mahiframework/http";
import { bootstrap } from "./bootstrap.js";

const app = await bootstrap();
const env = app.make<Env>("env");
const hostname = process.env.HOST || process.env.SERVER_HOST;

const listening = await listenHttpServer(app, {
  port: env.PORT,
  ...(hostname ? { hostname } : {}),
});

app.logger.info(`Server listening on ${formatServeUrl(listening.hostname, listening.port)}`);

const untrap = trap(["SIGINT", "SIGTERM"], (signal) => {
  untrap();
  app.logger.info(`Received ${signal}, shutting down...`);
  void (async () => {
    await listening.close();
    await app.terminate();
  })();
});
```

It boots the same `bootstrap()` the CLI and the test suite use, binds
`@hono/node-server` once, and exits if the bind fails. No supervision, no
watching, no port walking — one process doing one thing, which is what a
process manager wants.

`listenHttpServer()` also injects the websocket upgrade handler into the
HTTP server when a broadcast driver is bound, so websockets work on the
same port with no extra wiring. See [Broadcasting](../broadcasting/).

Note the log line uses `listening.hostname`, not a hardcoded
`localhost` — in a container the server binds `0.0.0.0`, and a line
claiming `localhost` points at the one interface it is *not* reachable on
from outside.

### Graceful shutdown

The signal handler is the difference between a clean stop and a
`SIGKILL`. An orchestrator sends `SIGTERM`, waits out a grace period, and
then kills; a process that ignores `SIGTERM` therefore always dies the
hard way, with in-flight requests cut mid-response and pools dropped
without closing.

Two steps, in order:

1. **`listening.close()`** — stop accepting connections, close open
   websockets with a `1001 "going away"` frame, drop idle keep-alives,
   give in-flight requests up to 10s to finish
   (`close({ drainTimeoutMs })` to change it), then destroy the rest.
2. **`app.terminate()`** — run every provider's `shutdown()` hook,
   releasing database pools, Redis clients, and anything else the
   application opened.

Both are needed. `close()` alone leaves the *application's* connections
open, and each of those keeps Node's event loop alive on its own — so the
listener goes away and the process keeps running with nothing to do.
Equally, `close()` without the websocket step never resolves at all: a
bare `server.close()` waits for open connections to end, and an upgraded
websocket never ends.

There is deliberately no `process.exit()`. Once both steps finish the
event loop is empty and Node exits by itself; forcing it would truncate
whatever is still flushing.

Set the process manager's stop timeout comfortably above the drain
window: `TimeoutStopSec` (systemd), `stopwaitsecs` (supervisor),
`terminationGracePeriodSeconds` (Kubernetes).

See [Application lifecycle](../lifecycle/#termination).

## Why `artisan serve` is not for production

`ServeCommand` is a **development supervisor**, and every one of its
features is wrong on a server.

**It forks a child and polls `.env` every 500ms.** With reload enabled
(the default), the command you run is a parent that spawns a worker child
of the same command, then `statSync`es `.env` twice a second looking for
an mtime change:

```ts
const ENV_POLL_MS = 500;
// ...
if (current !== undefined && current > lastModified) {
  lastModified = current;
  resolve("env");   // → SIGTERM the child, respawn it
}
```

That's a lovely development loop and a liability in production: two
processes where you expected one, a restart triggered by a config
management tool touching a file, and an inotify-free polling loop burning
a syscall pair per tick forever.

**It walks ports on `EADDRINUSE`.** Without an explicit `--port` or
`SERVER_PORT`, `bindWithRetries()` tries up to `--tries` (default 10)
consecutive ports:

```ts
attempts: binding.portWasExplicit ? 1 : parseTries(options),
```

On a laptop, "8000 was busy so I'm on 8001" is a convenience. Behind a
load balancer configured to health-check port 8000, it's a service that
starts successfully and receives no traffic — the worst possible failure
mode, because nothing errors.

**It defaults to `127.0.0.1`.** `DEFAULT_HOST` is loopback, so without
`--host 0.0.0.0` the process is unreachable from another container or
another host.

**It respawns the worker through `tsx`.** `serveWorkerArgs()` resolves
`node_modules/tsx/dist/cli.mjs` and re-runs `bin/console.ts` under it.
That requires a dev dependency and re-transpiles the whole application on
every restart.

`--no-reload` disables the supervisor and gives you a single in-process
server, which is closer — but you're still going through `tsx` and still
walking ports. Run `bin/server.js` instead.

## Environment

Environment variables are validated at boot by `loadEnv({ schema })`
against your `config/env.ts` zod schema, and every problem is reported at
once:

```
Invalid environment configuration:
  APP_KEY: Required
  PORT: Expected number, received nan
```

The process exits. That's the intent — an app that boots with a broken
config surfaces the problem inside a request weeks later. See
[Configuration](../configuration/).

### The three that matter

**`NODE_ENV=production`.** It flows into `app.useEnvironment(env.NODE_ENV)`,
which drives `app.environment()`, `isProduction()`, and `isLocal()`. The
template's schema restricts it to `development | test | production`, so a
typo fails at boot rather than silently selecting a fourth environment.

**`APP_KEY` is required and has no default.** This is deliberate:

```ts
/**
 * Set by `./artisan key:generate`. Optional here (not `.default()`) so a
 * missing key fails loudly inside `EncryptionServiceProvider` with an
 * actionable message instead of silently encrypting under a fixed key.
 */
APP_KEY: z.string().optional(),
```

The schema marks it optional so the *encryption provider* can throw the
useful message:

```
APP_KEY is not set. Run `./artisan key:generate` and add the printed value to your .env file.
```

Generate it once, per environment, and treat it as a secret:

```bash
./artisan key:generate
```

It must decode to exactly 32 bytes. Every derived key — the encrypter, the
signer for signed URLs, session and token machinery — is HKDF-derived from
it, so **rotating `APP_KEY` invalidates everything encrypted or signed
under the old one.** `key:generate` refuses to overwrite an existing key
for exactly that reason; `--force` rotates anyway. Before rotating, copy
the outgoing value into `APP_PREVIOUS_KEYS` (comma-separated) so
`Encrypter`/`Signer` can still read old data — the command will not do it
for you, and once the old key is gone it is unrecoverable.

See [Encryption & hashing](../encryption/).

**`APP_URL` is what absolute URLs are built from** when there is no
in-flight request to borrow the host from — queue jobs, scheduled tasks,
CLI commands, mailables. It's wired through `http.url`:

```ts
export function httpConfig(env: Env): HttpConfig {
  return { url: env.APP_URL, cors: { /* ... */ } };
}
```

A live request's own scheme and host take precedence. With neither, the
URL generator **throws** rather than guessing:

```
Cannot generate an absolute URL: no active request and no `http.url`
config set. Set `http.url` (APP_URL) or pass `{ absolute: false }`.
```

The failure mode this prevents is silent and expensive: password reset and
email verification links generated inside a queue job would otherwise
point at `http://localhost:8000` in every production email. Set `APP_URL`
to the public origin — the one users see, not the container's internal
address.

Also set `CORS_ORIGIN` to your real frontend origins. The template
defaults it to `http://localhost:3000`, which is right for development and
useless in production.

### The default environment is `"production"`

```ts
private environmentName: string = process.env.NODE_ENV ?? "production";
```

With `NODE_ENV` unset, the `Application` calls itself production. That is a
fail-safe, matching Laravel's `APP_ENV` default: an unknown environment
gets `isProduction()`-gated safety checks turned **on** rather than off. A
forgotten variable degrades toward caution, not toward a debug-mode
service on the public internet.

Note the base app's own env schema defaults `NODE_ENV` to
`"development"` — a different fail-safe for a different situation (a
developer who hasn't written a `.env` yet gets a development app). Once
`bootstrap()` calls `app.useEnvironment(env.NODE_ENV)`, the validated
value wins. **Set `NODE_ENV` explicitly in production** and the question
doesn't arise.

### Where variables come from

`loadEnv()` reads `process.env`. On a server, prefer real environment
variables — from systemd's `Environment=`, Docker's `--env-file`, or your
orchestrator's secret store — over shipping a `.env` file into the image.
The template's `.gitignore` excludes `.env` for the obvious reason.

## The process model

This is the section that decides your architecture, because **three
framework defaults are single-process-only**. Not as a caveat — as their
defining limit.

A new app is configured like this:

```ts
cacheConfig()        // default: "array"
queueConfig()        // default: "sync"
broadcastingConfig() // default: "local"
```

All three are correct for one process and wrong the instant you run two.

### `array` cache: nothing is shared

`ArrayCacheStore` is a `Map` in one process's memory. Two processes have
two Maps and share nothing:

- **Rate limits multiply.** `Limit.perMinute(5)` across three processes is
  really 15 per minute, because each counts independently. Whether a
  request is throttled depends on which process the load balancer picked.
- **`Cache.remember()` computes N times**, once per process.
- **`Cache.forget()` clears one process.** The others keep serving the
  stale value until their own TTLs expire.
- **`Cache.lock()` guarantees nothing.** Each process's `add()` is atomic
  within itself and invisible to the others, so two processes both acquire
  "the" lock — which takes `WithoutOverlapping` job middleware and
  `rememberViaLock()` down with it.

The `file` store shares the data but not the atomicity: its write queue is
an **in-process** promise chain, and two processes writing the same JSON
file have no shared lock. It fixes durability across restarts, not
correctness across processes.

### `sync` queue: no worker, no isolation

`SyncQueueDriver` runs the job inside the request that dispatched it. The
work isn't deferred, doesn't retry, doesn't survive a crash, and adds its
full runtime to your response time. It's a development convenience — it
means dispatching works without running a worker — and it is not a
deployment strategy.

The `database` driver is multi-process-safe: reserving is a single atomic
statement, so two workers never take the same job, and a reservation that
outlives `retryAfter` is reclaimed so a killed worker's job runs again.

### `local` broadcast: the silent one

`LocalBroadcastDriver` keeps its `channel → sockets` map in one process's
memory. With two or more server processes, a broadcast from process A
**silently never reaches** a client whose websocket landed on process B.
No exception, no warning, no log line. You discover it in production,
intermittently, as "notifications sometimes don't show up."

This is the worst of the three precisely because nothing errors.

### The fix

```ts
// config/app.ts — after the Cache/Queue/Broadcast providers
RedisServiceProvider,
```

```ts
// config/cache.ts
{ default: "redis", stores: { array: {}, file: { path: "storage/cache" }, redis: {} } }

// config/queue.ts
{ default: "redis", connections: { sync: {}, database: {}, redis: { queue: "default" } } }

// config/broadcasting.ts
{ default: "redis", connections: { local: { path: "/broadcasting/socket" }, redis: { path: "/broadcasting/socket" } } }
```

No call site changes, because every consumer already talks to the
`CacheStore` / `QueueDriver` / `BroadcastDriver` interface. Set
`REDIS_URL` (or `REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD`), and set a
connection `keyPrefix` if anything else shares that Redis — it is what
separates your application's keys, and your broadcast channel, from a
co-tenant's. `RedisCacheStore.flush()` is additionally scoped to the
cache's own `cache:` namespace, so it can never reach the queue's keys
even on one connection with no prefix at all.

If you don't need websockets and your queue volume is low, the `database`
queue driver plus a single web process is a perfectly legitimate
deployment. **One process is a valid architecture; two processes on the
defaults is not.**

See [Redis](../redis/) for the full picture.

## Running queue workers

A worker is a separate long-running process:

```bash
node dist/bin/console.js queue:work
node dist/bin/console.js queue:work --connection database
node dist/bin/console.js queue:work --sleep 1
```

| Flag | Default | Meaning |
|---|---|---|
| `--connection <name>` | the default connection | Which connection to drain |
| `--sleep <seconds>` | `3` | How long to sleep when the queue is empty |
| `--once` | — | Process a single job (or wait once) and exit — for scripts and tests |

The loop is: pop a job, run it through its middleware, delete it on
success, release it with a backoff on failure, and sleep when there's
nothing to do. Default backoff is `attempts * 5` seconds unless the job
overrides `backoff()`.

### Graceful shutdown via SIGTERM

```ts
const untrap = trap(["SIGINT", "SIGTERM"], () => {
  running = false;
});
```

**Both** signals are trapped, and `SIGTERM` is the one that matters:
containerized and orchestrated deployments send `SIGTERM` first and
`SIGKILL` after a grace period. Trapping only `SIGINT` would leave the
worker unable to finish an in-flight job before being force-killed.

The handler only flips a flag, and the loop tests it **after** finishing
the current iteration (`} while (running)`). A signal received mid-job
lets that job complete and then stops — it does not abort the work. Give the
process manager a `stop` timeout longer than your slowest job:
`TimeoutStopSec` in systemd, `stopwaitsecs` in supervisor,
`terminationGracePeriodSeconds` in Kubernetes. Too short and `SIGKILL`
kills a job mid-write; the job will be retried when its reservation
expires, but any non-idempotent side effect has already half-happened.

Once the loop exits, `ConsoleKernel.run()` calls `app.terminate()` in a
`finally`, which runs every provider's `shutdown()` hook and closes the
database pool and any Redis client the worker opened. Without that the
worker stops taking jobs and then **hangs** — an open pool keeps Node's
event loop alive on its own — until the orchestrator's grace period
elapses and `SIGKILL` arrives. See
[Application lifecycle](../lifecycle/#termination).

### Restart workers on deploy

A worker holds your application code in memory for its whole life. Deploy
new code and the old workers keep running the old code indefinitely.
**Restart them as part of every deploy** — there is no `queue:restart`
signal command here, so use your process manager:

```bash
systemctl restart mahi-worker@1 mahi-worker@2
# or
supervisorctl restart mahi-worker:*
```

### Supervision

Workers exit — on an unhandled error, on an OOM kill, on a redeploy. They
must be restarted automatically. Run several for throughput; each one is
an independent consumer, and the drivers handle reservation.

A worker crashing in a loop is worth alerting on: with `Restart=always` and
no backoff, a worker that dies during boot will spin. systemd's
`RestartSec` and supervisor's `startretries` both handle this.

See [Queues](../queues/) for jobs, retries, chaining, failed jobs, and
`queue:retry`/`queue:failed`/`queue:flush`.

## Running the scheduler

The scheduler is **one cron entry** that runs every minute:

```cron
* * * * * cd /srv/app && node dist/bin/console.js schedule:run >> /dev/null 2>&1
```

`schedule:run` evaluates the schedule once, runs everything due right now,
and exits. That's the whole production story. Every task's own cron
expression lives in your provider's `schedule()` hook; the crontab knows
only "check every minute."

`schedule:work` is a **development convenience** — a foreground loop that
polls every second and fires due tasks once per wall-clock minute. It
exists so you don't need a crontab entry while developing. Unlike
Laravel's version there's no per-tick child process; tasks run in-process
through the same `runDueTasks()` path `schedule:run` uses. It works as a
long-running production process under a supervisor if a crontab isn't
available to you, but a cron entry is simpler and restarts itself.

### Run it on exactly one host — or share the lock

By default `withoutOverlapping()` is backed by **lock files on local
disk**:

```ts
const lockDir = app.config.get<string>("schedule.lockDirectory", "storage/schedule-locks");
```

Two hosts have two directories and no shared lock, so a
`withoutOverlapping()` task runs on both. Pick one host for the scheduler,
or make its tasks idempotent.

If you genuinely need the scheduler on more than one host, point the locks
at Redis instead:

```ts
// config/schedule.ts
export function scheduleConfig(): ScheduleConfig {
  return { lockDirectory: "storage/schedule-locks", lockStore: "redis" };
}
```

Redis's `add()` is a `SET NX`, so the lock is genuinely exclusive across
hosts. An in-memory store is refused (it can't lock across the processes
cron spawns) and falls back to files with a warning.

Either way, a lock past its expiry — 60 minutes by default, set per task
with `withoutOverlapping(minutes)` — is treated as abandoned so a crashed
task doesn't block its slot forever. The flip side: a task that
legitimately runs longer than its expiry can be started again
concurrently. Size the expiry above the task's worst case.

Two more behaviours to plan around: **a failing task is logged and
swallowed**, so `schedule:run` exits `0` even when a task threw — monitor
the log or use `pingOnFailure()`. And **foreground tasks run
sequentially**, so a slow one delays everything else due in the same
minute unless it's marked `runInBackground()`.

See [Scheduling](../scheduling/).

## Migrations on deploy

```bash
node dist/bin/console.js migrate
```

Run it once per deploy, from one place, before the new code starts serving
— a release job, an init container, a deploy hook. Not from every
container's entrypoint: concurrent `migrate` runs against the same
database race on the migrations table.

`migrate` runs everything pending across **every** migration directory —
yours plus every provider's contributed `migrations()` directory. Check
what's pending first if you want to know:

```bash
node dist/bin/console.js migrate:status
```

**Never run `migrate:fresh` or `migrate:refresh` against production.**
`fresh` drops every table. It is the right tool for a test database and a
catastrophe anywhere else.

Write migrations so that old and new code can both run against the
resulting schema for the duration of a rolling deploy: add a nullable
column and backfill, don't rename in place; drop a column in a *later*
deploy than the one that stopped writing to it.

See [Migrations](../migrations/).

## Storage and permissions

`storage/` holds anything the application writes at runtime:

```
storage/
├── app/private/          Local disk uploads
├── app/public/           Public disk uploads (served at /storage)
├── logs/                 single/daily log channels
├── cache/                file cache store — one file per key
└── schedule-locks/       withoutOverlapping() lock files
```

The whole tree is gitignored, so it does **not** exist in a fresh
checkout. Create it and make it writable by the user the app runs as:

```bash
mkdir -p storage/app/private storage/app/public storage/logs storage/cache storage/schedule-locks
chown -R app:app storage
```

`storage/cache/` is shared by every process on the host that uses the
`file` store, so it must be writable by all of them — the web server, the
`queue:work` worker, and whatever user's crontab runs `schedule:run`. That
sharing is the point: the file store's locks and rate limits are correct
across those processes precisely because they are looking at one
directory. Schedule `cache:prune` if you write far more keys than you read
back, since expired entries are otherwise only removed when read.

Everything under it resolves through `storage_path()`, which is
`process.cwd()` + `"storage"`. **The application must be started from its
own root directory.** `./artisan` handles this by `cd`ing to its own
directory first; `bin/server.js` does not, so set the working directory in
your process manager (`WorkingDirectory=` in systemd, `directory=` in
supervisor, `WORKDIR` in a Dockerfile).

Start it from the wrong directory and `storage_path()`, `database_path()`,
and a relative `DB_FILENAME` all point somewhere else — usually creating an
empty SQLite file rather than failing.

If you run more than one host, note that the local storage disk is
**per-host**: a file uploaded to host A is a 404 on host B. Use a shared
volume or a remote disk driver. See [Storage](../storage/).

## Logging

The template's default is a stack of `console` and `single`:

```ts
{
  default: "stack",
  channels: {
    console: { driver: "console" },
    single: { driver: "single", path: storage_path("logs/mahi.log") },
    daily: { driver: "daily", path: storage_path("logs/mahi.log"), maxFiles: 14 },
    stack: { driver: "stack", channels: ["console", "single"] },
  },
}
```

**In a container, log to stdout only.** Point `default` at `console` and
let the runtime collect it:

```ts
{ default: env.NODE_ENV === "production" ? "console" : "stack", channels: { /* ... */ } }
```

A container writing to a file inside its own ephemeral filesystem produces
logs that vanish with the container and a disk that fills up in the
meantime. `console` writes through Node's `console` methods, routed by
severity — `error`/`critical`/`alert`/`emergency` to `console.error`,
`warning`/`notice` to `console.warn` — so stderr and stdout separate the
way log collectors expect.

**On a plain VM, use `daily` rather than `single`.** `daily` rotates to a
dated file and prunes with `maxFiles`; `single` grows until the disk is
full. If you have logrotate configured, `single` plus logrotate is fine
too — just pick one.

Either way, log volume is a production concern nobody thinks about until
the disk fills. See [Logging](../logging/).

## Health checks

Two opt-in endpoints, answering two different questions. Configure both in
`config/http.ts`:

```ts
export function httpConfig(env: Env): HttpConfig {
  return {
    url: env.APP_URL,
    liveness: {},                               // GET /up
    healthCheck: { secret: env.HEALTH_SECRET }, // GET /health
    cors: { /* ... */ },
  };
}
```

Nothing is registered unless the key is present — a present-but-empty
object enables it at the default path.

| | `/up` | `/health` |
|---|---|---|
| Question | Is the process alive? | Should this instance receive traffic? |
| Kubernetes probe | `livenessProbe` | `readinessProbe` |
| Failure means | Restart the pod | Drain it, leave it running |
| I/O | None | Every registered check |
| During maintenance | **200** (exempt) | **503** (not exempt) |

`/up` answers "is this process serving HTTP", and does no dependency
checks at all. **It is exempt from maintenance mode** — `HttpKernel` passes
its path into the maintenance middleware's `alwaysExcept` list, so an
orchestrator can still reach it while the app is down. Without that
exemption, `artisan maintenance:down` would make every replica fail its
liveness probe and get restarted in a loop, turning a planned maintenance
window into an outage.

`/health` runs every check registered through a provider's `checks()`
hook — `@mahiframework/health` ships cache, database and filesystem checks — and
returns `200`, or `503` if any failed. It is deliberately **not**
maintenance-exempt: a readiness probe answering "ready" while you have
explicitly taken the app down would put traffic straight back on it.

**Never move dependency checks onto `/up`.** A liveness failure means
*restart the pod*, so a Redis blip on that endpoint restarts every pod in
the deployment at once — converting a recoverable dependency outage into a
full outage plus a thundering-herd reconnect. That asymmetry is the entire
reason there are two endpoints.

```yaml
livenessProbe:
  httpGet: { path: /up, port: 8000 }
  periodSeconds: 10
readinessProbe:
  httpGet: { path: /health, port: 8000 }
  periodSeconds: 10
```

Set the readiness `periodSeconds` above your worst-case run — checks run
sequentially by default, so that is roughly checks x `timeoutSeconds` — or
probes will overlap.

In production, failure messages on `/health` are replaced with
`"Check failed"`, because they are driver errors that name internal hosts
and paths (`connect ECONNREFUSED 10.0.1.4:5432`). Send the configured
`HEALTH_SECRET` as `X-Health-Secret` to see the real ones:

```sh
curl -H "X-Health-Secret: $HEALTH_SECRET" https://example.com/health
```

The same checks run from the CLI, which never redacts — use it as a
post-deploy smoke test:

```sh
./artisan health          # table; exits 1 if anything failed
./artisan health --json   # the exact payload /health serves
```

See [Health checks](../health/).

## Trusted proxies

Behind a load balancer, every request arrives from the balancer's IP. The
real client IP is in `X-Forwarded-For` — a header **any client can
forge**.

`Request.ip()` therefore returns the **socket peer** and never reads that
header on its own. That is safe by default but incomplete behind a proxy,
where it means every client looks like the balancer: per-IP rate limits
collapse into one shared global limit, and `X-Forwarded-Proto` is ignored
so `secure()` is false and generated links come out `http://`.

The scaffolded app already registers the fix, driven by env:

```bash
# .env — comma-separated proxy IPs/CIDRs, empty when nothing is in front
TRUSTED_PROXIES=10.0.0.0/8,172.16.0.0/12
TRUSTED_HOSTS=example.com,www.example.com   # empty derives from APP_URL
```

which reaches `AppServiceProvider.middleware()`:

```ts
export class AppServiceProvider extends ServiceProvider {
  middleware(): HttpPipe[] {
    return [
      trustProxies(["10.0.0.0/8", "172.16.0.0/12"]),
      trustHosts(["example.com", "*.example.com"]),
    ];
  }
}
```

Patterns are exact IPs, IPv4 CIDR blocks, or `"*"`. **`"*"` trusts every
peer**, which is appropriate only when the app is *guaranteed* to be
unreachable except through a proxy that overwrites client-supplied
`X-Forwarded-For` — a container with no published port, on a private
network, behind an ingress that rewrites the header. If a client can ever
reach the process directly, `"*"` is equivalent to no protection.

The forwarded chain is walked **right to left**, discarding trusted hops,
because proxies append and only the rightmost entries are vouched for.
When the peer can't be determined the middleware fails closed.

Once the peer is trusted, `X-Forwarded-Proto` / `-Host` / `-Port` are also
applied — which is what makes `request.secure()` true and password-reset
and verification links come out `https://` behind a TLS terminator.

`trustHosts()` validates the effective host against an allow-list and
403s otherwise, guarding against cache-poisoning and poisoned
password-reset links. `*.example.com` matches subdomains and the bare
domain; the port is ignored.

See [Routing](../routing/) and [Requests](../requests/).

## Maintenance mode

```bash
node dist/bin/console.js maintenance:down
node dist/bin/console.js maintenance:up
```

While down, every request gets a 503 with a JSON body.

| `maintenance:down` option | Effect |
|---|---|
| `--retry <seconds>` | Sets the `Retry-After` header |
| `--secret <secret>` | Bypass token |
| `--message <message>` | The 503 body's `message` field |
| `--status <code>` | Respond with something other than 503 |
| `--except <path...>` | Paths that stay reachable |

```bash
node dist/bin/console.js maintenance:down --retry 60 --message "Upgrading the database" --secret $(uuidgen)
```

The bypass secret is accepted **three ways** — as an
`X-Maintenance-Secret` header (for machines), as the first path segment
(for a human with a browser), or as the cookie the path form sets:

```bash
curl -H "X-Maintenance-Secret: $SECRET" https://example.com/posts
curl -c jar https://example.com/$SECRET      # 302 → /, sets the bypass cookie
```

The path form is a one-time exchange: it responds `302` to `/` with an
`HttpOnly`, `SameSite=Lax` cookie (12 hours, `Secure` when the request
was), so every subsequent request works normally without the secret in
the URL — and therefore out of the access logs of every proxy in front of
you. Secrets are compared in constant time.

**State is a marker file** at `storage/framework/down`, holding the
payload as JSON. That is what makes it work at all: `maintenance:down`
runs in a *different process* from the server, so cache-backed state on
the default `array` driver wrote the flag into the CLI's own heap and
then exited — the operator saw "Application is now in maintenance mode"
and the app kept serving traffic.

The operational consequences of a file:

- **Every process on the host sees it**, with no shared cache required.
- **`cache:clear` can't accidentally bring the app back up.**
- It is **per-host**. On a multi-host deployment, either run the command
  on each host, or put the marker on shared storage, or (usually better)
  drain at the load balancer instead.

When the app is up the check is a `stat` that is cached for one second,
so a healthy app is not paying a filesystem hit per request.

## A worked example

### Dockerfile

```dockerfile
# ---- build ----
FROM node:22-slim AS build
WORKDIR /app

# Native deps for better-sqlite3 and argon2.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Drop dev dependencies from the tree we'll copy forward.
RUN npm prune --omit=dev

# ---- runtime ----
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./

# storage/ is gitignored, so it must be created — and owned by the app user.
RUN mkdir -p storage/app/private storage/app/public storage/logs storage/cache storage/schedule-locks \
    && chown -R node:node /app/storage

USER node
EXPOSE 8000

# One process. No supervisor, no tsx, no port walking.
CMD ["node", "dist/bin/server.js"]
```

Three details that matter. The build stage keeps the toolchain that
`better-sqlite3` and `argon2` need to compile and the runtime stage
doesn't. `WORKDIR /app` is what makes `storage_path()` resolve correctly.
And `USER node` means `storage/` must be chowned, or the first log write
fails.

For the compiled console entry, add a second image target or just exec
into the same one:

```bash
docker compose run --rm app node dist/bin/console.js migrate
```

### docker-compose

```yaml
services:
  app:
    build: .
    environment:
      NODE_ENV: production
      PORT: 8000
      APP_URL: https://api.example.com
      APP_KEY: ${APP_KEY}
      DB_FILENAME: /data/database.sqlite
      REDIS_URL: redis://redis:6379
      CORS_ORIGIN: https://example.com
    volumes:
      - storage:/app/storage
      - data:/data
    depends_on: [redis]
    ports: ["8000:8000"]
    healthcheck:
      # Requires `health: {}` in config/http.ts.
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:8000/up').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 3s
      retries: 3

  worker:
    build: .
    command: ["node", "dist/bin/console.js", "queue:work", "--sleep", "1"]
    environment:
      NODE_ENV: production
      APP_URL: https://api.example.com
      APP_KEY: ${APP_KEY}
      DB_FILENAME: /data/database.sqlite
      REDIS_URL: redis://redis:6379
    volumes:
      - storage:/app/storage
      - data:/data
    depends_on: [redis]
    # Long enough for the slowest job to finish after SIGTERM.
    stop_grace_period: 60s

  scheduler:
    build: .
    command: ["node", "dist/bin/console.js", "schedule:work"]
    environment:
      NODE_ENV: production
      APP_URL: https://api.example.com
      APP_KEY: ${APP_KEY}
      DB_FILENAME: /data/database.sqlite
      REDIS_URL: redis://redis:6379
    volumes:
      - storage:/app/storage
      - data:/data
    depends_on: [redis]
    # Exactly one replica: withoutOverlapping() locks are local files.
    deploy:
      replicas: 1

  redis:
    image: redis:7-alpine
    volumes: ["redis:/data"]

volumes:
  storage:
  data:
  redis:
```

Notes on the shape:

**Every service shares `APP_KEY` and `APP_URL`.** A worker generating a
password-reset link needs `APP_URL` just as much as the web process, and a
worker decrypting a payload needs the same `APP_KEY`.

**Redis is present because there is more than one process.** The `array`
cache and `local` broadcast defaults would be wrong here even though only
`app` serves HTTP — the worker and the scheduler share cache keys, locks,
and rate-limiter counters with it.

**The scheduler is pinned to one replica.** Its `withoutOverlapping()`
locks are local files; two replicas have two lock directories. Redis is
already in this stack, so `schedule.lockStore: "redis"` would lift that
restriction if you ever need more than one.

**The SQLite volume is shared, and that's the weak point.** SQLite over a
shared Docker volume works for a small single-host deployment and does not
work across hosts. Moving to Postgres or MySQL is the next step; see
[Database](../database/).

### systemd

```ini
# /etc/systemd/system/mahi-web.service
[Unit]
Description=Mahi web
After=network.target

[Service]
Type=simple
User=app
WorkingDirectory=/srv/app
EnvironmentFile=/etc/mahi/app.env
ExecStart=/usr/bin/node dist/bin/server.js
Restart=always
RestartSec=2
KillSignal=SIGTERM
TimeoutStopSec=30
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```ini
# /etc/systemd/system/mahi-worker@.service — a template unit
[Unit]
Description=Mahi queue worker %i
After=network.target

[Service]
Type=simple
User=app
WorkingDirectory=/srv/app
EnvironmentFile=/etc/mahi/app.env
ExecStart=/usr/bin/node dist/bin/console.js queue:work --sleep 1
Restart=always
RestartSec=5
KillSignal=SIGTERM
# Must exceed the slowest job's runtime — SIGKILL mid-job loses work.
TimeoutStopSec=120
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now mahi-web
systemctl enable --now mahi-worker@1 mahi-worker@2 mahi-worker@3
```

`WorkingDirectory=/srv/app` is not optional — it's what `storage_path()`
and a relative `DB_FILENAME` resolve against. `EnvironmentFile` keeps
`APP_KEY` out of the unit file and out of `systemctl show` for
unprivileged users.

The scheduler is a crontab entry, not a unit:

```cron
* * * * * cd /srv/app && /usr/bin/node dist/bin/console.js schedule:run >> /dev/null 2>&1
```

Deploy sequence:

```bash
cd /srv/app
git pull && npm ci --omit=dev && npm run build
node dist/bin/console.js migrate
systemctl restart mahi-web 'mahi-worker@*'
```

The worker restart is the step people forget, and its symptom is jobs
running last week's code with no error anywhere.

### supervisor

If you're on supervisor rather than systemd:

```ini
[program:mahi-worker]
command=/usr/bin/node dist/bin/console.js queue:work --sleep 1
directory=/srv/app
user=app
numprocs=3
process_name=%(program_name)s_%(process_num)02d
autostart=true
autorestart=true
startretries=3
stopsignal=TERM
; Must exceed the slowest job's runtime.
stopwaitsecs=120
redirect_stderr=true
stdout_logfile=/var/log/mahi/worker.log
```

```bash
supervisorctl reread && supervisorctl update
supervisorctl restart mahi-worker:*
```

`stopsignal=TERM` is the important line — supervisor's default is `TERM`,
but set it explicitly, because that's the signal `queue:work` traps for
graceful shutdown.

## Deploy checklist

- [ ] `npm ci` and `npm run build` succeed (the build is your typecheck)
- [ ] `NODE_ENV=production`
- [ ] `APP_KEY` set, 32 bytes, and *not* rotated without `APP_PREVIOUS_KEYS`
- [ ] `APP_URL` is the public origin
- [ ] `CORS_ORIGIN` is your real frontend, not `localhost:3000`
- [ ] Running `bin/server.js`, not `artisan serve`
- [ ] Working directory is the application root
- [ ] `storage/` exists and is writable by the runtime user
- [ ] Redis configured if more than one process runs
- [ ] Migrations run once per deploy, from one place
- [ ] Queue workers supervised, and **restarted on every deploy**
- [ ] Worker stop timeout exceeds the slowest job
- [ ] `bin/server.ts` traps `SIGTERM` and calls `close()` then `terminate()`
- [ ] Stop timeout exceeds the HTTP drain window (10s by default)
- [ ] Exactly one scheduler host, one cron entry
- [ ] Logs going to stdout in a container, or `daily` on a VM
- [ ] `http.liveness` enabled and wired to the orchestrator's `livenessProbe`
- [ ] `http.healthCheck` enabled and wired to the `readinessProbe`, with `HEALTH_SECRET` set
- [ ] `TRUSTED_PROXIES` set if behind a proxy — and **empty if not**
- [ ] `TRUSTED_HOSTS` set (or `APP_URL` correct, which it's derived from)
- [ ] `curl -H 'X-Forwarded-Proto: https'` shows `https://` links, not `http://`
- [ ] Body limits suit your largest legitimate upload
- [ ] `storage/framework/` writable — maintenance mode writes its marker there

## Gotchas

**`artisan serve` walks ports.** Without an explicit port it silently
binds 8001 when 8000 is taken — a healthy process receiving no traffic.

**`artisan serve` binds `127.0.0.1` by default**, unreachable from another
container.

**`artisan serve` forks a supervisor child and polls `.env` twice a
second.** Two processes, and a restart triggered by anything that touches
the file.

**`./artisan` needs `tsx`.** In production run `node dist/bin/console.js`.

**A relative `DB_FILENAME` resolves against the working directory.**
Started from the wrong directory, it creates a new empty database rather
than failing.

**Path helpers use `process.cwd()` by default, not the module location.**
Set `WorkingDirectory`/`WORKDIR`. An app that genuinely cannot be run from
its own directory — an installed CLI, a compiled binary — pins its root
with `setBasePath()` instead; see
[Configuration](../configuration/README.md#setbasepath--for-apps-that-arent-run-from-their-own-directory).

**`storage/` is gitignored and won't exist in a fresh deploy.** Create it
and chown it.

**Two processes on the `array` cache means every rate limit multiplies**,
every lock is a no-op, and `Cache.forget()` clears one process.

**`local` broadcasting fails silently across processes.** No error, no
log — the message just doesn't arrive.

**`sync` queue runs jobs inside the request.** No retries, no isolation,
full runtime added to the response.

**Workers keep old code in memory.** Restart them on every deploy.

**A worker killed mid-job loses that attempt.** Set a stop timeout longer
than the slowest job.

**Scheduler `withoutOverlapping()` locks are local files by default.** Run
the scheduler on exactly one host, or set `schedule.lockStore` to a Redis
store.

**A failing scheduled task is logged and swallowed**; `schedule:run` still
exits `0`.

**`migrate:fresh` drops every table.** Never point it at production.

**Maintenance mode is per-host.** The marker file lives at
`storage/framework/down` on the machine that ran the command. Run it on
each host, share the volume, or drain at the load balancer.

**Both health endpoints are opt-in.** No `http.liveness` key, no `/up`
route; no `http.healthCheck` key, no `/health` route — and your probe 404s.
A 404 reads as a failure to most orchestrators, so an unconfigured probe is
worse than no probe.

**Dependency checks belong on `/health`, never `/up`.** Putting them on the
liveness endpoint means a dependency blip restarts every pod at once.

**`trustProxies(["*"])` trusts a forged `X-Forwarded-For` from anyone who
can reach the process directly.** Only use it when that's impossible.

**Forgetting `TRUSTED_PROXIES` behind a load balancer doesn't fail
loudly.** `request.ip()` becomes the balancer's address for every client,
so per-IP rate limits silently become one global limit — and one abusive
client locks out everyone. It also leaves `secure()` false, so
password-reset links go out as `http://`.

**Rotating `APP_KEY` invalidates everything encrypted or signed under the
old key.** Copy it into `APP_PREVIOUS_KEYS` *before* `key:generate
--force`; afterwards it's gone.

**With `NODE_ENV` unset, the `Application` defaults to `"production"`.**
Set it explicitly so the fail-safe never has to fire.

## Related

- [Installation](../installation/) — creating and running an app locally
- [Configuration](../configuration/) — the env schema, config files
- [Application lifecycle](../lifecycle/) — what `bootstrap()` does
- [Redis](../redis/) — the multi-process story in full
- [Queues](../queues/) — jobs, retries, failed jobs, `queue:work`
- [Scheduling](../scheduling/) — `schedule:run`, task locking
- [Migrations](../migrations/) — schema changes on deploy
- [Logging](../logging/) — channels, stacks, rotation
- [Storage](../storage/) — disks and the per-host caveat
- [Encryption & hashing](../encryption/) — `APP_KEY` and key rotation
- [Console](../console/) — every `artisan` command
