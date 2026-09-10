export { Command } from "./command.js";
export type { CommandClass } from "./command.js";

export { ConsoleKernel, renderConsoleError } from "./console-kernel.js";
export type { ConsoleKernelOptions } from "./console-kernel.js";

export { deriveProgramName, isCompiledBinary, resolveRuntimeMode } from "./runtime-mode.js";
export type { RuntimeMode } from "./runtime-mode.js";

export { ConsoleServiceProvider, CONSOLE_KERNEL_TOKEN } from "./console-service-provider.js";

export { collectMigrationSources } from "./commands/migration-directories.js";

export { trap } from "./signals.js";
export type { Signal } from "./signals.js";

export { scaffold, toClassName, FileExistsError } from "./commands/make/scaffold.js";
export type { ScaffoldOptions } from "./commands/make/scaffold.js";

import "./provider-hooks.js";
