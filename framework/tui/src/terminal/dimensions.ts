/**
 * Terminal size accessors. Node exposes `process.stdout.columns`/`.rows`
 * directly (populated from the underlying TTY via `ioctl`), so unlike
 * PHP's `Terminal.php` (which falls back to shelling out to `stty size`
 * or reading `COLUMNS`/`LINES` env vars), no subprocess is ever needed
 * here, falls back to the conventional 80x24 default when stdout isn't
 * a TTY (e.g. piped output, CI, `Tui.fake()`).
 */

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

export function cols(): number {
  return process.stdout.columns ?? DEFAULT_COLUMNS;
}

export function rows(): number {
  return process.stdout.rows ?? DEFAULT_ROWS;
}
