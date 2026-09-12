import { Redis } from "ioredis";
import { RedisConnection, type RedisConnectionConfig } from "../src/redis-connection.js";

/**
 * These tests talk to a real Redis (ioredis has no faithful in-memory
 * substitute for pub/sub across connections or blocking/atomic semantics).
 *
 * When no Redis is reachable they self-skip via `describe.skipIf` — except
 * under `CI=true`, where they **fail** instead. A suite that silently
 * skips is worse than no suite on CI: the pipeline stays green while the
 * only tests covering cross-process locking, `flush()` scoping and
 * broadcast fanout never run, so a regression in exactly the code Redis
 * exists for ships unnoticed. Locally, skipping is still the right
 * default — see `docker-compose.yml` at the repo root for a one-command
 * Redis if you want them running.
 */

const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

/** Prefix every key/channel this suite creates lives under, so a shared dev Redis stays identifiable. */
export const TEST_PREFIX = "mahi-test:";

let availability: boolean | undefined;

/** True if a Redis server answered a PING within a short timeout. Cached across the run. */
export async function redisAvailable(): Promise<boolean> {
  if (availability !== undefined) {
    return availability;
  }

  const client = new Redis(REDIS_URL, {
    lazyConnect: true,
    connectTimeout: 500,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });

  try {
    await client.connect();
    await client.ping();
    availability = true;
  } catch {
    availability = false;
  } finally {
    client.disconnect();
  }

  return availability;
}

/**
 * Vitest evaluates `describe.skipIf(condition)` synchronously, so it can't
 * await `redisAvailable()`. This probes once at module load with a short
 * timeout and caches the result for the suite.
 */
const available = await redisAvailable();

if (!available && process.env.CI === "true") {
  throw new Error(
    `No Redis at ${REDIS_URL}. The @mahiframework/redis integration tests must run on CI — ` +
      `start one with \`docker compose up -d redis\`, or set REDIS_URL.`,
  );
}

export const REDIS_UNAVAILABLE = !available;

/** A unique key prefix, namespacing one test (or one simulated app) away from every other. */
export function testPrefix(): string {
  return `${TEST_PREFIX}${Math.random().toString(36).slice(2)}:`;
}

/**
 * A connected `RedisConnection` against the test server.
 *
 * Isolated by a random key prefix **unless one is passed in** — several
 * tests need two connections sharing a prefix, because that is what two
 * processes of the *same* application look like, and a random prefix each
 * would make them two different applications instead (which, since the
 * broadcast channel is now prefixed too, no longer cross-talk at all).
 */
export async function testConnection(
  overrides: RedisConnectionConfig = {},
): Promise<RedisConnection> {
  const connection = new RedisConnection({
    url: REDIS_URL,
    keyPrefix: testPrefix(),
    ...overrides,
  });
  await connection.connect();

  return connection;
}
