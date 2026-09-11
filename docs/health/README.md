# Health checks

An application declares the things that must be working, in a provider's
`checks()` hook, and gets both an HTTP endpoint and a CLI command over the
same runner and the same result shape.

```ts
export class AppServiceProvider extends ServiceProvider {
  checks(): HealthCheck[] {
    return [
      {
        name: "stripe",
        async run() {
          const res = await fetch("https://api.stripe.com/healthcheck");
          if (!res.ok) return `Stripe returned ${res.status}`;
        },
      },
    ];
  }
}
```

```json
{"core":{"cache":true,"database":true,"filesystem":true},
 "app":{"daemon":true,"stripe":"Failed to connect"}}
```

`true` passed, a string is why it failed, `null` was skipped. `GET /health`
returns `200` when everything passed and `503` when anything failed;
`./artisan health` prints a table and exits `0` or `1`.

## Liveness vs readiness

This is the part to understand before anything else, because the two
endpoints look redundant and are not.

`@mahi/http` registers an opt-in `GET /up` that does no I/O at all.
`@mahi/health` adds an opt-in `GET /health` that runs every check. They are
the two halves of the standard orchestrator split:

| | `/up` | `/health` |
|---|---|---|
| Question | Is the process alive? | Should this instance receive traffic? |
| Kubernetes probe | `livenessProbe` | `readinessProbe` |
| Failure means | Restart the pod | Drain it, leave it running |
| I/O | None | Every registered check |
| During maintenance | **200** (exempt) | **503** (not exempt) |
| Config | `http.liveness` | `http.healthCheck` |

**Do not collapse these into one endpoint.** If `/up` started doing real
I/O, a Redis blip would fail the *liveness* probe and Kubernetes would
restart every pod in the deployment — converting a recoverable dependency
outage into a full outage, plus a thundering-herd reconnect against the
dependency that was already struggling. The blast radius of a wrong
readiness answer is "this instance stops receiving traffic"; the blast
radius of a wrong liveness answer is the entire deployment. That asymmetry
is the whole reason two probes exist.

For the same reason `/health` is deliberately **not** exempt from
maintenance mode while `/up` is. An orchestrator must be able to tell a
down-for-maintenance app from a dead one, so `/up` keeps answering 200. But
a readiness probe answering "ready" while an operator has explicitly taken
the app down would put traffic straight back onto it.

## Writing a check

A check is a plain object — a name and a function. There is no base class
to extend and no file-per-check convention.

```ts
import type { HealthCheck } from "@mahi/health";

const stripe: HealthCheck = {
  name: "stripe",
  run: () => stripeClient.ping(),
};
```

| Field | |
|---|---|
| `name` | Result-object key within the group. Lowercase and stable — it goes in the JSON. |
| `group` | Result-object group. Defaults to `"app"`. |
| `timeoutSeconds` | Per-check deadline. Defaults to `health.timeoutSeconds` (5). |
| `run(app)` | The probe. Receives the `Application`. |

### The three ways to report

These look like three ways to say one thing. They are not.

```ts
// Throw — what a real dependency failure does on its own.
run: () => cache.put("k", "v"),           // ECONNREFUSED propagates as the message

// Return a string — completed normally, but the result is wrong.
run: () => disk.usage() > 0.9 ? "disk 94% full" : undefined,

// Return null — skip. This app doesn't use this dependency.
run: (app) => app.has(STRIPE_TOKEN) ? stripe.ping() : null,
```

Returning nothing (or `true`) passes.

**Throwing is not an error you need to catch.** A driver rejecting with
`ECONNREFUSED` is the check working correctly; the registry converts it to
that check's failure message. Wrapping every check in `try/catch` to return
a string instead is pure ceremony.

**Skipped is not passed.** A database check in an app with no database
bound has verified nothing, and reporting `true` there is a lie that will
eventually be believed. A skipped check does not fail the report.

### Checks must be cheap

`run()` executes on every probe interval, on every instance. A check that
does a table scan is a self-inflicted load source that gets worse exactly
when the system is already unwell. Probe one trivial round trip; never
aggregate, never scan.

## The built-in checks

`@mahi/health` registers three under the `core` group. Each skips itself
when its package isn't installed, so an app without `@mahi/storage` reports
`"filesystem": null` rather than failing to start.

| Check | What it does |
|---|---|
| `cache` | Puts a random value on the default store, reads it back, asserts equality, forgets it. |
| `database` | `select 1` on the default connection. |
| `filesystem` | Writes a unique file to the default disk under `health-check/`, reads it back, compares, deletes it. |

The cache and filesystem checks are deliberately **round trips, not
writes.** A `put` that succeeds against a store whose reads are broken — a
full disk, a replica accepting writes it discards, a filesystem that went
read-only after the mount was cached — reports healthy. Reading back a
value only this invocation could have written is the only assertion that
catches it.

The database check uses `select 1` rather than introspecting tables: it is
portable across sqlite/MySQL/Postgres, touches no application table, and
cannot be affected by schema state. It checks the **default connection
only** — checking every configured connection means a probe whose cost
scales with your config file and which fails on a deliberately-offline
analytics replica. Register a second check if you need a second connection
probed.

### Replacing a built-in

Register a check with the same group and name. Later registrations win, and
framework providers are collected first, so your app always gets the last
word.

```ts
checks(): HealthCheck[] {
  return [
    { group: "core", name: "database", run: () => myManagedDb.ping() },
  ];
}
```

## The endpoint

Opt in from `config/http.ts`. Nothing is mounted unless the key is set.

```ts
export function httpConfig(env: Env): HttpConfig {
  return {
    liveness: {},                              // GET /up
    healthCheck: { secret: env.HEALTH_SECRET }, // GET /health
  };
}
```

| Key | |
|---|---|
| `path` | Route path. Defaults to `/health`. |
| `failureStatus` | Status when any check fails. Defaults to `503`. |
| `secret` | `X-Health-Secret` value that un-redacts messages in production. |

`503` rather than `500` is deliberate: a load balancer drains a 503 and
pages on a 500, and a failing dependency is the former.

The route is registered by `@mahi/http` when `@mahi/health` is installed and
the config key is set. `@mahi/health` itself depends only on `@mahi/core`,
so `./artisan health` works in an app with no HTTP package at all.

### Redaction

Failure messages are driver errors, and they name internal topology:

```
connect ECONNREFUSED 10.0.1.4:5432
getaddrinfo ENOTFOUND prod-redis.internal
SQLITE_CANTOPEN: unable to open database file /srv/app/storage/prod.sqlite
```

`/health` is by definition reachable from whatever probes it — often a load
balancer, sometimes the internet, and always before anyone remembers to put
an ACL on it. So in production every failure message is replaced with
`"Check failed"` unless the request carries `X-Health-Secret` matching the
configured `secret`:

```sh
curl -H "X-Health-Secret: $HEALTH_SECRET" https://example.com/health
```

Which checks exist and which failed stays visible; only the message goes.
Redaction never applies outside production, and never on the CLI — that
runs inside the trust boundary, and an operator who has SSH'd into the box
needs the real message.

The header mirrors `X-Maintenance-Secret`. Unlike that one it is
header-only: accepting a secret in the URL path is right for a browser
being pointed at a downed site, and wrong for a machine probe that would
write it into every access log.

## The command

```sh
./artisan health
./artisan health --json
```

```
  Group   Check        Status
  core    cache        ✔ ok
  core    database     ✔ ok
  core    filesystem   ○ skipped
  app     stripe       ✘ Failed to connect

  4 checks, 1 failed (124ms)
```

Exits `1` if any check failed, `0` otherwise — so it works as a deployment
gate or a smoke test:

```sh
./artisan health || exit 1
```

`--json` emits exactly the same payload the endpoint serializes, so CI and
your load balancer are looking at the same bytes:

```sh
./artisan health --json | jq '.core.database'
```

## Configuration

The optional `health` namespace:

```ts
export function healthConfig(): HealthConfig {
  return {
    timeoutSeconds: 5,
    concurrency: 1,
  };
}
```

| Key | |
|---|---|
| `timeoutSeconds` | Default per-check deadline. Defaults to `5`. |
| `concurrency` | How many checks run at once. Defaults to `1`. |

### Why checks run sequentially

Parallel is the tempting default and it is wrong for a probe. Every check
is I/O against a dependency that is *already suspected of being unwell* —
that is why it is being probed. Firing all of them at once, once per probe
interval, from every instance, is a synchronised burst of connection
attempts at exactly the moment the dependency can least absorb it. A health
check that amplifies the outage it was installed to detect is a well-known
operational hazard.

Sequential also keeps the timeout arithmetic legible: N checks at a 5s
deadline is a worst case of N×5s, which you can compare against your probe
interval. Raise `concurrency` only once you have measured the worst case
and found it too slow.

### Timeouts

Every check races a deadline, and a check that exceeds it reports
`Timed out after 5s` rather than hanging. Without this, one check on a TCP
connection with no socket timeout would hang the request until the load
balancer's own timeout fired — at which point the balancer has learned
nothing, and the app is holding one open request per probe interval,
forever.

## Kubernetes

```yaml
livenessProbe:
  httpGet: { path: /up, port: 8000 }
  periodSeconds: 10
readinessProbe:
  httpGet: { path: /health, port: 8000 }
  periodSeconds: 10
  httpHeaders:
    - name: X-Health-Secret
      valueFrom: { secretKeyRef: { name: app-secrets, key: health-secret } }
```

Set `periodSeconds` above your worst-case run (checks × `timeoutSeconds`),
or probes will overlap.

## See also

- [Providers](../providers/) — the `checks()` hook alongside the others
- [Routing](../routing/) — both probe endpoints
- [Console](../console/) — `./artisan health`
- [Deployment](../deployment/) — probes in a real deployment
