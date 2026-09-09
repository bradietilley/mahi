/**
 * Pins the package defaults for the whole suite.
 *
 * Without this, any assertion that relies on a *default* would encode
 * whatever `TZ` or `LANG` the developer's machine or CI runner happens to
 * use, and the suite would pass locally and fail in CI (or worse, vice
 * versa). Tests that genuinely care about a zone or locale name it
 * explicitly; tests that care about the host's own settings set them
 * themselves and restore them afterwards.
 */

import { beforeEach } from "vitest";

import { setDefaultLocale, setDefaultTimezone, setDefaultWeekStartsOn } from "../src/config.js";
import { DateTime } from "../src/date-time.js";

beforeEach(() => {
  setDefaultTimezone("UTC");
  setDefaultWeekStartsOn(1);
  setDefaultLocale("en");
  DateTime.setTestNow(null);
});
