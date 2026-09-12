import type { CommandClass } from "./command.js";

declare module "@mahiframework/core" {
  interface ProviderHooks {
    /**
     * Return command classes this provider contributes. Collected by
     * ConsoleKernel and registered onto the Commander program.
     */
    commands?(): CommandClass[];
  }
}
