import { ConsoleKernel, CONSOLE_KERNEL_TOKEN, renderConsoleError } from "@mahiframework/cli";
import { bootstrap } from "./bootstrap.js";

const app = await bootstrap();
const kernel = app.make<ConsoleKernel>(CONSOLE_KERNEL_TOKEN);

kernel.collectFromProviders();

// `run()` terminates the application in its own `finally`, which is what
// closes database pools and Redis clients — an open pool keeps Node's
// event loop alive, so without it a command finishes its work and then
// the process just sits there. The `catch` is here so a failed command
// exits non-zero (which is what a CI step or a `&&` chain reads) instead
// of dying on an unhandled rejection, and `renderConsoleError` prints ONE
// readable line (the full stack only with `-v`/`--verbose`/`DEBUG`) rather
// than ~40 lines of driver internals.
try {
  await kernel.run();
} catch (error) {
  renderConsoleError(error);
}
