# Application lifecycle

An `Application` is a [`Container`](../container/) that also owns config,
log context, a fallback logger, and the provider lifecycle. Getting from
`new Application()` to a running server is four steps, all of them in one
function you write and own.

```ts
const app = new Application();
app.useEnvironment(env.NODE_ENV);   // 1. environment
app.config.set("database", ...);    // 2. config
app.register(SomeServiceProvider);  // 3. providers
await app.bootstrap();              // 4. register -> boot
// ... the app runs ...
await app.terminate();              // 5. terminating -> shutdown
```

## The Application object

```ts
export class Application extends Container {
  readonly config = new ConfigRepository();
  readonly context = new ContextRepository();
  readonly logger: Logger = new ConsoleLogger(this);
  // ...
}
```

Those three are plain `readonly` fields, initialized when the object is
constructed. They are **available before any provider runs** — before
`bootstrap()`, before `register()`, before anything is bound. That's
deliberate: config has to be writable before providers read it, and
logging has to work during boot, including when boot is what failed.

| Member | Type | Available from |
|---|---|---|
| `config` | `ConfigRepository` | construction |
| `context` | `ContextRepository` | construction |
| `logger` | `Logger` (a `ConsoleLogger`) | construction |

`app.logger` is the zero-config fallback and is not the same thing as the
configurable `LogManager` bound at `LOG_TOKEN` by
`LoggingServiceProvider`. Wiring `app.logger` through the container would
create a bootstrap-ordering hazard — logging that happens before the
logging provider registers would have nothing to write to. Instead there
are two: an always-available `ConsoleLogger` on the field, and an opt-in
multi-channel `LogManager` in the container. See [Logging](../logging/).

`ConsoleLogger` is constructed with `this` as its log source, which is
safe inside a field initializer because it only stores the reference and
reads `environment()` and `context` lazily at log time. So even the
fallback logger renders full lines:

```
[2026-08-27 10:14:02] production.INFO: Server listening {"port":8000}
```

## bootstrap()

The whole sequence, in order:

1. **Guard.** If already booted, return immediately. If a bootstrap is
   already *in flight*, return that same promise — see below.
2. **Set the global.** `setCurrentApp(this)` populates the `app()` helper
   and therefore every facade, **before** any provider runs.
3. **Instantiate.** Every queued provider class is constructed with the
   application, in registration order. From this point `getProviders()`
   returns them all.
4. **Register.** `register()` is called on every provider, in order, each
   awaited. All registration finishes before step 5 begins.
5. **Boot.** `boot()` is called on every provider, in order, **each
   awaited before the next starts**. Not `Promise.all`.
6. **Mark booted.** `isBooted()` becomes true.

Steps 4 and 5 are the two-stage lifecycle described in [Service
providers](../providers/). Step 5's sequentiality is a contract, not an
implementation detail: `BroadcastServiceProvider.boot()` mounts a route
onto the kernel that `HttpServiceProvider.boot()` built, and
`AuthServiceProvider` needs the database connection that
`DatabaseServiceProvider.boot()` opened.

**Step 2 comes first**, which is what makes `app()` — and every facade
built on it (`Log`, `Events`, `Context`) — usable inside `register()` and
`boot()`. Laravel binds its container globally ahead of provider
registration for the same reason. Constructor injection is still the
better choice inside a provider (you already have `this.app`), but a
helper called from a provider no longer has to thread the app through.

| Method | Returns |
|---|---|
| `register(providerClass)` | `void` — queues a class for instantiation |
| `bootstrap()` | `Promise<void>` — runs the full lifecycle once |
| `isBooted()` | `boolean` |
| `getProviders()` | `readonly ServiceProvider[]` — empty before bootstrap |
| `terminating(cb)` | `this` — queue a shutdown callback |
| `terminate()` | `Promise<void>` — run the shutdown sequence once |
| `isTerminated()` | `boolean` |

### Concurrent and failed bootstraps

`booted` only becomes true once the *last* provider has booted, so two
callers racing into `bootstrap()` would both clear a naive
`if (this.booted) return` guard and boot every provider twice —
double-binding singletons, mounting routes twice, opening two pools.
Concurrent calls share the same in-flight run instead:

```ts
await Promise.all([app.bootstrap(), app.bootstrap()]);  // providers run once
```

If a provider's `boot()` throws, `bootstrap()` rejects and `isBooted()`
stays false. A retry **resumes from the provider that threw** rather than
starting over: `register()` is not re-run (which would re-instantiate
every provider and re-bind every singleton), and providers that already
booted are not booted again.

```ts
try {
  await app.bootstrap();
} catch (error) {
  // fix the connection, then:
  await app.bootstrap();   // resumes; earlier providers are untouched
}
```

Recovering a half-booted application is still rarely the right call. The
resumability is there so that a retry which *does* happen is not silently
corrupting, not to encourage retrying.

## Registering providers

```ts
register(providerClass: ServiceProviderClass): void {
  this.providerClasses.push(providerClass);
}
```

It takes a **class**, not an instance — construction happens inside
`bootstrap()`. `ServiceProviderClass` is `new (app: Application) => ServiceProvider`.

The base app registers from an exported array:

```ts
for (const providerClass of providers) {
  app.register(providerClass);
}
```

**Registering after `bootstrap()` is a silent no-op.** The class gets
pushed onto the list, but nothing reads that list again. Your provider is
never instantiated, `register()` and `boot()` never run, and no error is
raised. If a provider's routes mysteriously don't exist, check whether it
was registered before bootstrap.

**`getProviders()` is empty before `bootstrap()`.** `providers` is only
populated at step 2. This is why every hook collector in the framework
runs from a `boot()` hook or later — `HttpKernel.collectFromProviders()`
is called from `HttpServiceProvider.boot()`, and
`ConsoleKernel.collectFromProviders()` is called from `bin/console.ts`
after `bootstrap()` resolves.

## Environment

```ts
private environmentName: string = process.env.NODE_ENV ?? "production";
```

**The default is `"production"`, not `"development"`.** This is a
fail-safe. An unknown environment is treated as production, so anything
gated on `isProduction()` — safety checks, confirmation prompts, stricter
cookie flags — defaults to *on* rather than off. Getting production
behaviour in development is an annoyance; getting development behaviour in
production is an incident. Laravel makes the same choice with `APP_ENV`.

| Method | Behaviour |
|---|---|
| `useEnvironment(name)` | Set the environment name. Returns `this`. |
| `environment()` | The current name, e.g. `"local"`, `"production"`, `"test"`. |
| `environment(...names)` | `true` if the current environment matches any given name. |
| `isLocal()` | `environmentName === "local"` |
| `isProduction()` | `environmentName === "production"` |

`environment()` is overloaded exactly like Laravel's:

```ts
app.environment();                       // "local"
app.environment("local");                // true
app.environment("staging", "local");     // true
app.environment("staging", "testing");   // false
```

### Pin it from your validated schema

The constructor reads `process.env.NODE_ENV` raw. If your app validates
its environment through a schema — and the base app does — call
`useEnvironment()` with the validated value right after construction:

```ts
const env = loadEnv({ schema: envSchema });

const app = new Application();
app.useEnvironment(env.NODE_ENV);
```

Now `environment()`, `isLocal()`, and `isProduction()` reflect the same
value everything else in the app validated against — including any
`.default()` the schema applied — rather than an unvalidated
`process.env` read. The base app's schema declares
`NODE_ENV: z.enum(["development", "test", "production"]).default("development")`,
so a missing `NODE_ENV` yields `"development"` there while the
`Application` constructor's own fallback would have said `"production"`.
`useEnvironment()` is what reconciles the two. See
[Configuration](../configuration/#the-environment-schema).

Note that `isLocal()` checks for exactly `"local"`, and the base app's
schema doesn't include that value — it uses `"development"`. If you want
`isLocal()` to mean anything, add `"local"` to your schema.
`environment("development")` works regardless.

## The three entrypoints

Every entrypoint calls the same `bootstrap()` function:

```ts
// bin/bootstrap.ts
export async function bootstrap(): Promise<Application> {
  const env = loadEnv({ schema: envSchema });

  const app = new Application();
  app.useEnvironment(env.NODE_ENV);
  app.instance("env", env);

  app.config.set("database", databaseConfig(env));
  app.config.set("http", httpConfig(env));
  app.config.set("cache", cacheConfig());
  // ... one line per config namespace

  for (const providerClass of providers) {
    app.register(providerClass);
  }

  await app.bootstrap();

  return app;
}
```

```ts
// bin/console.ts — the CLI, and therefore ./artisan
const app = await bootstrap();
const kernel = app.make<ConsoleKernel>(CONSOLE_KERNEL_TOKEN);

kernel.collectFromProviders();

try {
  await kernel.run();   // terminates the app in its own finally
} catch (error) {
  app.logger.error(error instanceof Error ? error.message : String(error), { error });
  process.exitCode = 1;
}
```

```ts
// bin/server.ts — production HTTP
const app = await bootstrap();
const env = app.make<Env>("env");

const listening = await listenHttpServer(app, { port: env.PORT });
app.logger.info(`Server listening on ${formatServeUrl(listening.hostname, listening.port)}`);

const untrap = trap(["SIGINT", "SIGTERM"], () => {
  untrap();
  void (async () => {
    await listening.close();   // drain HTTP + close websockets
    await app.terminate();     // release pools, clients, handles
  })();
});
```

```ts
// tests — via @mahiframework/testing
testApp = await createTestApplication(bootstrap);
```

`createTestApplication` takes your bootstrap function as a parameter
rather than importing it, since the testing package can't depend on any
specific app. It sets `DB_FILENAME` to a temp SQLite file and `NODE_ENV`
to `"test"` before calling it, then runs every migration.

### Why one bootstrap function matters

The entrypoint-specific part of each file above is two or three lines. The
wiring — environment validation, config, provider list, boot — is shared
verbatim.

This is what makes `./artisan route:list` show the routes your server will
actually serve, and what makes a test exercise the same middleware stack,
the same guards, and the same event listeners as production. There is no
"test bootstrap" that drifts from the real one, and no CLI bootstrap that
forgets to register a provider until a scheduled task fails at 3am.

It also means route collection has to be entrypoint-independent, and it
is: `HttpServiceProvider.boot()` calls `kernel.collectFromProviders()`
regardless of who booted the app. By the time `bin/server.ts` calls
`listenHttpServer()`, or `route:list` runs through the console, every route
is already mounted.

The one thing the console entrypoint does that others don't is
`kernel.collectFromProviders()` for **commands**, called explicitly after
bootstrap. Commands are only needed by the CLI, so collecting them is the
CLI's job rather than a provider's.

## Building an application by hand

The generated layout isn't required. The minimum is an `Application`,
some config, and providers:

```ts
import { Application } from "@mahiframework/core";
import { DatabaseServiceProvider } from "@mahiframework/database";
import { HttpServiceProvider, listenHttpServer } from "@mahiframework/http";

const app = new Application();

app.config.set("database", {
  default: "sqlite",
  connections: { sqlite: { filename: "database/database.sqlite" } },
});

app.register(DatabaseServiceProvider);
app.register(HttpServiceProvider);

await app.bootstrap();
await listenHttpServer(app, { port: 8000 });
```

Config must be set before `bootstrap()` — providers read it in
`register()` and in factories resolved during `boot()`.

## Termination

`bootstrap()` acquires; `terminate()` releases. It is the mirror image of
boot, and it exists because of one fact about Node:

**An open connection keeps the event loop alive.** A process holding a
MySQL pool, a Postgres pool, or an ioredis socket does not exit when its
work is done — it sits there until something kills it. `mahi migrate`
against MySQL never exited at all. A `schedule:run` cron entry with
`CACHE_STORE=redis` left a zombie process behind every minute.

```ts
await app.terminate();
```

The sequence:

1. **`terminating()` callbacks**, in **reverse** registration order
   (LIFO), each awaited.
2. **Providers' `shutdown()` hooks**, in **reverse** registration order,
   each awaited.
3. The global `app()` is cleared, but only if this application is the
   current one.

Both loops are best-effort: every hook runs inside its own `try`/`catch`
and a failure is logged rather than thrown. The process is going down
regardless, and one broken teardown must not strand a database pool that
the next hook would have closed. `terminate()` therefore never rejects.

It is also **idempotent** — a second call does nothing — so a signal
handler and an entrypoint's own `finally` can both call it. There is no
un-terminate: an application that has been terminated should be
discarded, not reused.

### terminating()

For teardown that belongs to the application rather than to a provider:

```ts
app.terminating(async () => {
  await metrics.flush();
});
```

LIFO ordering means a callback registered later — and therefore
potentially depending on what an earlier one set up — unwinds first.
Returns `this` for chaining.

### The shutdown() provider hook

```ts
export class ReportingServiceProvider extends ServiceProvider {
  private timer?: NodeJS.Timeout;

  boot(): void {
    this.timer = setInterval(() => this.flush(), 30_000);
  }

  async shutdown(): Promise<void> {
    clearInterval(this.timer);
    await this.flush();
  }
}
```

Implement it for anything that keeps the event loop alive: pools,
sockets, intervals, watchers, file handles. Two rules:

- **Make it best-effort.** Do not throw for a failure that does not
  matter once the process is gone.
- **Guard against a partial boot.** `shutdown()` can run after an earlier
  provider's `boot()` threw, so your own `boot()` may never have created
  the state you are tearing down.

The framework's own providers implement it:

| Provider | `shutdown()` does |
|---|---|
| `DatabaseServiceProvider` | `disconnect()` every **resolved** connection — closes MySQL/Postgres pools and the sqlite handle |
| `RedisServiceProvider` | Stop the broadcast subscriber, then `quit()` every resolved connection |

"Resolved" matters here. Shutdown walks the drivers a manager actually
built, never the *configured* list — resolving a connection in order to
close it would construct a pool during shutdown, opening connections in
order to close them.

### Who calls terminate()

You mostly don't have to; every entrypoint the framework ships does it:

| Entrypoint | Where |
|---|---|
| `ConsoleKernel.run()` | A `finally`, so every command — including one that threw — terminates. Opt out with `new ConsoleKernel(app, { terminate: false })`. |
| `artisan serve` | After the listener closes. |
| `bin/server.ts` (scaffolded) | A `SIGINT`/`SIGTERM` handler: `listening.close()` then `app.terminate()`. |
| `createTestApplication().cleanup()` | Before deleting the temp database directory. |

### Graceful HTTP close

`listenHttpServer()` returns a `ListeningServer` whose `close()` is a
real graceful shutdown, not a bare `server.close()`:

```ts
await listening.close();                          // 10s drain (default)
await listening.close({ drainTimeoutMs: 30_000 }); // longer
await listening.close({ drainTimeoutMs: 0 });      // immediate
```

In order: open websockets are closed with a `1001 "going away"` frame,
idle keep-alive sockets are dropped, in-flight requests get
`drainTimeoutMs` to finish, and anything still open is destroyed.

The websocket step is not an optimization. `server.close()` waits for
open connections to end, and an upgraded websocket never ends on its own
— so a server with one connected client hangs forever. That is the
"SIGTERM and the process appears to shut down, then sits until it is
SIGKILLed" symptom.

Cutting a request off at the end of the drain window is deliberate. The
alternative is not "the request completes", it is "the orchestrator
SIGKILLs the process" — which cuts it off anyway *and* skips every
remaining shutdown hook.

`close()` is idempotent and concurrent calls share one close, so a signal
handler and an explicit call can both run.

### A note on lazy connections

`RedisServiceProvider.boot()` only connects when some config actually
points at Redis. That gating still matters, and is still the right shape
for a provider you write: not opening a socket at all is better than
opening one and closing it.

## Gotchas

**`bootstrap()` is idempotent, and quietly so.** A second call returns
immediately with no error. Convenient, but it means a double-bootstrap bug
looks like nothing at all.

**A throwing provider leaves `booted` false.** Bindings registered before
the throw persist on the container, and the global *is* set (it is set
first, so that `app()` works during boot). A retry resumes rather than
restarting, but recovering a half-booted application is still rarely the
right call — usually you want to crash.

**`terminate()` never throws.** A failing `shutdown()` is logged, not
raised. If you need to know whether teardown succeeded, check for
yourself inside the hook; the return value tells you nothing.

**A terminated application is not reusable.** Its pools are closed and
`app()` no longer resolves it. Build a new one.

**`isLocal()` is exact-match `"local"`.** It does not mean "not
production". Use `environment("development", "local", "test")` if that's
what you mean.

**The environment default surprises people once.** With no `NODE_ENV` and
no `useEnvironment()` call, you're in production. That's intentional.

**Async `register()` blocks all registration.** It's awaited in the same
loop as everyone else's, so slow I/O there delays every subsequent
provider's registration. Put I/O in `boot()`.

## Related

- [Service providers](../providers/) — what runs during register and boot
- [Service container](../container/) — what `bootstrap()` populates
- [Configuration](../configuration/) — `loadEnv`, config namespaces
- [Testing](../testing/) — `createTestApplication(bootstrap)`
- [Deployment](../deployment/) — running `bin/server.ts` in production
