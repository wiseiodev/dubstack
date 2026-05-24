/**
 * Parses a short human-readable duration like `30s`, `5m`, `1h`, `250ms`, or
 * a bare integer (interpreted as milliseconds) into milliseconds.
 *
 * Accepts case-insensitive units. Whitespace around the value is ignored.
 * Returns `null` for empty / malformed input so callers can render their own
 * actionable error rather than throwing a generic parse exception.
 */
export function parseDuration(input: string | undefined | null): number | null {
  if (input == null) return null;
  const trimmed = String(input).trim();
  if (!trimmed) return null;
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i.exec(trimmed);
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value) || value < 0) return null;
  const unit = (match[2] ?? 'ms').toLowerCase();
  const factor =
    unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : unit === 's' ? 1_000 : 1;
  return Math.round(value * factor);
}

/** Renders a millisecond count back to a compact `<n>s`/`<n>m`/`<n>h` label. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}
