/**
 * Locale-aware number formatting plus a handful of hand-rolled helpers
 * (`fileSize`/`abbreviate`/`clamp`) with no `Intl` equivalent.
 * Thin wrapper over Node's built-in `Intl.NumberFormat`, Laravel's
 * `Illuminate\Support\Number`, minus `spell`/`ordinal` (low value,
 * locale-table-heavy).
 *
 * Exported as `Num`. It is deliberately *not* named `Number`: doing so
 * shadows the global `Number` constructor in every importing module, so a
 * later `Number(x)`/`Number.isInteger(...)` becomes a runtime `TypeError`.
 * A deprecated `Number` alias remains for backward compatibility only.
 */

export interface NumberFormatOptions {
  locale?: string;
  precision?: number;
  maxPrecision?: number;
}

function formatter(
  options: NumberFormatOptions | undefined,
  extras: Intl.NumberFormatOptions = {},
): Intl.NumberFormat {
  const locale = options?.locale;
  const formatOptions: Intl.NumberFormatOptions = { ...extras };

  if (options?.precision !== undefined) {
    formatOptions.minimumFractionDigits = options.precision;
    formatOptions.maximumFractionDigits = options.precision;
  } else if (options?.maxPrecision !== undefined) {
    formatOptions.maximumFractionDigits = options.maxPrecision;
  }

  return new Intl.NumberFormat(locale, formatOptions);
}

const FILE_SIZE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB", "EB"] as const;
const ABBREVIATE_UNITS = ["", "K", "M", "B", "T", "Q"] as const;

export const Num = {
  format(value: number, options?: NumberFormatOptions): string {
    return formatter(options).format(value);
  },

  currency(value: number, currency = "USD", options?: NumberFormatOptions): string {
    return formatter(options, { style: "currency", currency }).format(value);
  },

  /**
   * Format `value` as a percentage string. `value` is already in percent
   * form. `percentage(10)` is `"10%"`, matching Laravel's
   * `Number::percentage(10)`, not `Intl`'s 0–1 fraction convention.
   */
  percentage(value: number, options?: NumberFormatOptions): string {
    const precision = options?.precision ?? 0;

    return `${formatter({ ...options, precision }).format(value)}%`;
  },

  fileSize(bytes: number, precision = 0): string {
    if (!globalThis.Number.isFinite(bytes) || bytes < 0) {
      return formatter({ precision }).format(0) + " B";
    }

    let amount = bytes;
    let unit = 0;

    while (amount / 1024 > 0.9 && unit < FILE_SIZE_UNITS.length - 1) {
      amount /= 1024;
      unit += 1;
    }

    return `${formatter({ precision }).format(amount)} ${FILE_SIZE_UNITS[unit]}`;
  },

  abbreviate(value: number, precision = 0): string {
    const sign = value < 0 ? "-" : "";
    let amount = Math.abs(value);
    let unit = 0;

    while (amount >= 1000 && unit < ABBREVIATE_UNITS.length - 1) {
      amount /= 1000;
      unit += 1;
    }

    return `${sign}${formatter({ precision }).format(amount)}${ABBREVIATE_UNITS[unit]}`;
  },

  clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
  },
} as const;
