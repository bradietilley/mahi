/**
 * `@mahiframework/tui` — a from-scratch TypeScript/Node port of
 * `laravel/prompts`, scoped to `note`/`error`/`warning`/`info`/
 * `success`/`intro`/`outro`, `ask`, `select`, `progress`, `spinner`,
 * and `table`, exposed through the static `Tui` facade. No dependency
 * on `@mahiframework/core` or any other framework package — usable
 * standalone, and talks directly to `process.stdin`/`process.stdout`.
 *
 * ```ts
 * import { Tui } from "@mahiframework/tui";
 *
 * Tui.note("Deployed to production.");
 * const name = await Tui.ask("What's your name?", { default: "World" });
 * const env = await Tui.select("Which environment?", { options: ["local", "staging", "production"] });
 * ```
 *
 * Known limitation: display-width measurement (used for box/table
 * alignment and text truncation) uses a hand-rolled, minimal East
 * Asian Width table rather than a full Unicode width database — common
 * CJK text and emoji are measured correctly, but uncommon wide
 * characters outside the covered ranges may be measured as width 1
 * instead of 2, throwing box/table alignment off by a column or two.
 * See `src/render/text-width.ts` for the exact ranges covered.
 */
export { Tui } from "./tui.js";
export type { FakeTuiHandle } from "./tui.js";
export type { NoteType } from "./note.js";
export type { AskOptions } from "./ask.js";
export type { SelectOptions } from "./select.js";
export type { ConfirmOptions } from "./confirm.js";
export type { SecretOptions } from "./secret.js";
export { ProgressBar } from "./progress.js";
export type { TaskResult } from "./task.js";

/**
 * Raw ANSI color wrappers (`colors.red("text")`, etc.) — exported for
 * consumers that want to color their own table cells/strings (e.g.
 * `route:list` coloring HTTP methods) without reaching into
 * `@mahiframework/tui`'s internal `src/ansi/colors.ts` module path.
 */
export * as colors from "./ansi/colors.js";

/**
 * Whether ANSI colour is currently being emitted (respects `NO_COLOR`/
 * `FORCE_COLOR`/TTY), and a hook to force it on/off. Exported so consumers
 * (and their tests) can gate their own colouring the same way `@mahiframework/tui`
 * does.
 */
export { colorsEnabled, setColorOverride } from "./context.js";

/**
 * Whether prompts will actually prompt — the same check `ask`/`select`/
 * `confirm` make before running interactively, honouring the
 * `Tui.interactive()` override that `Tui.fake()` sets.
 *
 * The READ half of `Tui.interactive()`, which until now was write-only.
 * Consumers need it because "is there anybody to ask" is a decision they have
 * to make *before* choosing to prompt at all: an app that offers a picker on a
 * terminal and an error message otherwise has to branch on this, and the
 * obvious hand-rolled `process.stdin.isTTY && process.stdout.isTTY` silently
 * ignores the override — so the interactive branch becomes unreachable from
 * every test, which is the half that most needs covering.
 */
export { isInteractive } from "./context.js";
