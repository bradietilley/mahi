import { trap } from "@mahiframework/cli";
import { formatServeUrl, listenHttpServer } from "@mahiframework/http";
import type { Env } from "../config/env.js";
import { bootstrap } from "./bootstrap.js";

const app = await bootstrap();
const env = app.make<Env>("env");
const hostname = process.env.HOST || process.env.SERVER_HOST;

const listening = await listenHttpServer(app, {
  port: env.PORT,
  ...(hostname ? { hostname } : {}),
});

// The address the server ACTUALLY bound, not an assumed "localhost".
// Those differ whenever `HOST` is set — a container binds `0.0.0.0`, and
// a log line claiming `localhost` there points at the one interface the
// server is not reachable on from outside the container.
app.logger.info(`Server listening on ${formatServeUrl(listening.hostname, listening.port)}`);

/**
 * Graceful shutdown.
 *
 * SIGTERM is what an orchestrator (Docker, Kubernetes, systemd) sends
 * first, then it waits a grace period and sends SIGKILL. A process that
 * ignores SIGTERM therefore always dies the hard way: in-flight requests
 * are cut mid-response, and database pools / Redis clients are dropped
 * without closing.
 *
 * So: stop accepting connections and drain the open ones (`close()`),
 * then release everything the application itself opened (`terminate()`,
 * which runs every provider's `shutdown()` hook). Once both are done the
 * event loop has nothing left in it and Node exits on its own — there is
 * deliberately no `process.exit()`, which would truncate whatever is
 * still flushing.
 */
const untrap = trap(["SIGINT", "SIGTERM"], (signal) => {
  untrap();
  app.logger.info(`Received ${signal}, shutting down...`);

  void (async () => {
    try {
      await listening.close();
      await app.terminate();
    } catch (error) {
      app.logger.error("Shutdown failed.", { error });
      process.exitCode = 1;
    }
  })();
});
