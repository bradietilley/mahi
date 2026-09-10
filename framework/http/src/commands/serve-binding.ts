/**
 * Host/port resolution for `artisan serve`, matching Laravel's
 * `ServeCommand::host()` / `port()` / `getHostAndPort()` /
 * `canTryAnotherPort()`.
 */

export interface ServeOptions {
  host?: string;
  port?: string;
  tries?: string;
  /**
   * Set when calling `handle()` directly in tests. Commander's
   * `--no-reload` flag instead sets `reload: false` (negated boolean).
   */
  noReload?: boolean;
  /** Commander's parsed form of `--no-reload`. */
  reload?: boolean;
}

export interface ServeBinding {
  hostname: string;
  port: number;
  /**
   * True when the port came from `--port` or `SERVER_PORT` — Laravel
   * then does not walk `--tries` alternate ports.
   */
  portWasExplicit: boolean;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8000;

/**
 * Split `--host` into `[hostname, port?]` — IPv6 (`[::1]:8080`) first,
 * then a single `host:port` colon split.
 */
export function getHostAndPort(host: string): [string, string | undefined] {
  const ipv6 = host.match(/^(\[.*\]):?([0-9]+)?$/);

  if (ipv6) {
    return [ipv6[1] ?? host, ipv6[2]];
  }

  const [hostname, port] = host.split(":");

  return [hostname ?? host, port];
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }

  const port = Number(value);

  return Number.isInteger(port) && port >= 0 ? port : undefined;
}

export function resolveServeBinding(
  options: ServeOptions,
  env: NodeJS.ProcessEnv = process.env,
): ServeBinding {
  const rawHost = options.host ?? env.SERVER_HOST ?? DEFAULT_HOST;
  const [hostname, hostPort] = getHostAndPort(rawHost);

  const cliPort = parsePort(options.port);
  const envServerPort = parsePort(env.SERVER_PORT);
  const envPort = parsePort(env.PORT);
  const embeddedPort = parsePort(hostPort);

  const portWasExplicit = cliPort !== undefined || envServerPort !== undefined;
  const port = cliPort ?? embeddedPort ?? envServerPort ?? envPort ?? DEFAULT_PORT;

  return { hostname, port, portWasExplicit };
}

/** Strip IPv6 brackets so Node's `listen({ hostname })` accepts the address. */
export function nodeHostname(hostname: string): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1);
  }

  return hostname;
}

export function formatServeUrl(hostname: string, port: number): string {
  const host = hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;

  return `http://${host}:${port}`;
}

export function isNoReload(options: ServeOptions): boolean {
  return options.noReload === true || options.reload === false;
}

/**
 * Marks the child process `serve` supervises, so it doesn't try to
 * supervise itself. Named with the `MAHI_*` prefix like every other
 * framework environment variable.
 */
export const SERVE_WORKER_ENV = "MAHI_SERVE_WORKER";

export function shouldSupervise(
  options: ServeOptions,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env[SERVE_WORKER_ENV]) {
    return false;
  }

  return !isNoReload(options);
}
