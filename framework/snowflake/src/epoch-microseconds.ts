/**
 * Wall-clock microseconds since the Unix epoch, with sub-millisecond
 * precision from `process.hrtime.bigint()` anchored to `Date.now()`.
 *
 * Same idea as php-snowflake's `EpochNanoseconds`: `Date.now()` only
 * has millisecond resolution, so a monotonic high-resolution clock is
 * layered on top to distinguish IDs generated in the same millisecond.
 * The pair is captured once (the first call in this isolate) so later
 * readings stay monotonic even if the wall clock steps.
 */

import { SnowflakeException } from "./errors.js";

let referenceHrtimeNs: bigint | undefined;
let referenceEpochMicros: number | undefined;

export function epochMicrosecondsNow(): number {
  if (referenceHrtimeNs === undefined) {
    referenceHrtimeNs = process.hrtime.bigint();
    referenceEpochMicros = Date.now() * 1000;
  }

  const elapsedNs = process.hrtime.bigint() - referenceHrtimeNs;

  return referenceEpochMicros! + Number(elapsedNs / 1000n);
}

/**
 * Parse an epoch start string into microseconds since the Unix epoch.
 *
 * `'YYYY-MM-DD HH:MM:SS'` (and the `T`-separated variant) is interpreted
 * in the host local timezone, matching PHP `strtotime()` / `date()` so
 * a PHP-generated ID and a TS-generated ID with the same epoch string
 * share the same numeric origin. Any other string is handed to
 * `Date.parse()`.
 */
export function parseEpochToMicroseconds(epochStart: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(epochStart);

  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6]);

    return new Date(year, month - 1, day, hour, minute, second).getTime() * 1000;
  }

  const ms = Date.parse(epochStart);

  if (Number.isNaN(ms)) {
    throw new SnowflakeException(`Invalid epoch start "${epochStart}".`);
  }

  return ms * 1000;
}

/**
 * Format a Unix timestamp (seconds) as `'YYYY-MM-DD HH:MM:SS'` in the
 * host local timezone — PHP `date('Y-m-d H:i:s', ...)`.
 */
export function formatLocalDateTime(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");

  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}
