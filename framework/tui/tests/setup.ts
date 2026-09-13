import { setColorOverride } from "../src/context.js";

/**
 * The colour wrappers are gated on a real TTY / `NO_COLOR` / `FORCE_COLOR`
 * (see `colorsEnabled()`), and the test runner is neither a TTY nor sets
 * those, so without this every renderer would emit plain text and the many
 * tests that assert on the ANSI-styled output would fail. Forcing colour on
 * for the whole suite keeps those tests testing what they mean to. The
 * dedicated `color-detection.test.ts` clears this override per-test to
 * exercise the real env/TTY logic.
 */
setColorOverride(true);
