import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { app as currentApp, storage_path, type Application } from "@mahiframework/core";

export const MAINTENANCE_MODE_TOKEN = "maintenance-mode";

/**
 * The marker file whose EXISTENCE means "this application is down".
 *
 * Laravel puts it at `storage/framework/down` and this matches, because
 * the reasoning is the same and it is not a stylistic choice.
 *
 * Not the cache store. `maintenance:down` runs in a **separate process**
 * from the server: with the default `array` driver that process would
 * write the flag into its own heap and exit, so the server never observes
 * it, the operator sees "Application is now in maintenance mode" while
 * the app keeps serving traffic. With a shared driver it works until
 * `cache:clear` silently brings the app back up, or until the cache is
 * the thing being maintained.
 *
 * A file on disk has neither problem: it survives the CLI process, is
 * visible to every worker on the host, and nothing else in the framework
 * will delete it.
 */
export function maintenanceFilePath(): string {
  return storage_path("framework", "down");
}

/**
 * The payload written when the application is placed into maintenance
 * mode, mirrors the fields Laravel's `php artisan down` accepts, minus
 * the ones tied to Blade view rendering (`render`/`redirect`, which have
 * no analog in a JSON-only API).
 */
export interface MaintenanceData {
  /** `Retry-After` header value (seconds). */
  retryAfter?: number;
  /** Bypass secret, a request presenting it (see the middleware) is let through. */
  secret?: string;
  /** Human-readable message returned in the 503 body's `message` field. */
  message?: string;
  /** HTTP status to respond with (defaults to 503). */
  status?: number;
  /** Paths (glob-style, `*` wildcard) that stay reachable while down, e.g. the health check. */
  except?: string[];
}

/**
 * Application maintenance-mode state, backed by a marker file (see
 * `maintenanceFilePath`).
 *
 * `activate()`/`deactivate()` are driven by the `maintenance:down`/
 * `maintenance:up` CLI commands; `active()`/`data()` are read by the
 * maintenance middleware on every request.
 *
 * The read path is cached in memory with a short TTL. The middleware
 * runs ahead of everything on every request, and a `stat`+`read` per
 * request, on the overwhelmingly common path where the app is UP and
 * the file does not exist, is a syscall pair bought for nothing. One
 * second of staleness at the start of a maintenance window is not a
 * meaningful cost; a filesystem hit on every request forever is.
 */
export class MaintenanceMode {
  /** How long a read of the marker file is reused for, in milliseconds. */
  private static readonly CACHE_TTL_MS = 1_000;

  private cached: { data: MaintenanceData | undefined; readAt: number } | undefined;

  constructor(private readonly app: Application) {}

  /** Place the application into maintenance mode with the given payload. */
  async activate(data: MaintenanceData = {}): Promise<void> {
    const path = maintenanceFilePath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(data), "utf8");
    this.invalidate();
  }

  /** Bring the application back up (no-op if it was already up). */
  async deactivate(): Promise<void> {
    await rm(maintenanceFilePath(), { force: true });
    this.invalidate();
  }

  /** True while the application is down for maintenance. */
  async active(): Promise<boolean> {
    return (await this.data()) !== undefined;
  }

  /** The stored maintenance payload, or `undefined` when the app is up. */
  async data(): Promise<MaintenanceData | undefined> {
    const now = Date.now();

    if (this.cached && now - this.cached.readAt < MaintenanceMode.CACHE_TTL_MS) {
      return this.cached.data;
    }

    const data = await this.read();
    this.cached = { data, readAt: now };

    return data;
  }

  /**
   * Drop the cached read, so the next `data()` hits disk. Called after
   * this process changes the state itself, an operator running
   * `maintenance:up` must not be told the app is still down for another
   * second.
   */
  invalidate(): void {
    this.cached = undefined;
  }

  private async read(): Promise<MaintenanceData | undefined> {
    let contents: string;
    try {
      contents = await readFile(maintenanceFilePath(), "utf8");
    } catch {
      // No file (the normal case), or unreadable. Either way the app is
      // up: failing OPEN here is deliberate, a permissions problem on
      // the marker file must not take a healthy application offline.
      return undefined;
    }

    try {
      const parsed: unknown = JSON.parse(contents);

      return parsed !== null && typeof parsed === "object" ? (parsed as MaintenanceData) : {};
    } catch {
      // The file exists but is empty or corrupt. Existence is the
      // signal; the payload is decoration. Stay down with defaults,
      // the opposite (coming back up because the JSON was truncated
      // mid-write) is the far worse failure.
      this.app.logger.warning("maintenance: marker file is not valid JSON; using defaults.");

      return {};
    }
  }
}

/**
 * Resolve the app-wide `MaintenanceMode` singleton. Bound by
 * `HttpServiceProvider` under `MAINTENANCE_MODE_TOKEN`; this helper saves
 * middleware/command call sites from repeating the `make()` + token
 * import.
 */
export function maintenanceMode(app: Application = currentApp()): MaintenanceMode {
  return app.make<MaintenanceMode>(MAINTENANCE_MODE_TOKEN);
}
