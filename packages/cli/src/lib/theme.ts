import chalk, { Chalk, type ChalkInstance } from 'chalk';
import type { ThemeMode } from './config';

export type ResolvedTheme = 'dark' | 'light' | 'none';

export interface ResolveThemeOptions {
  noColor?: boolean;
  env?: NodeJS.ProcessEnv;
}

/**
 * Detect terminal background from `COLORFGBG` (e.g. "15;0" → bg=0 → dark).
 * Returns 'unknown' when the env var is missing or unparseable.
 */
export function detectTerminalTheme(
  env: NodeJS.ProcessEnv = process.env,
): 'dark' | 'light' | 'unknown' {
  const colorFgBg = env.COLORFGBG;
  if (!colorFgBg) return 'unknown';
  const parts = colorFgBg.split(';');
  if (parts.length < 2) return 'unknown';
  const bgRaw = parts[parts.length - 1];
  const bg = Number.parseInt(bgRaw, 10);
  if (!Number.isFinite(bg)) return 'unknown';
  // Standard ANSI palette: 0-6 + 8 are dark; 7 + 9-15 are light.
  if ((bg >= 0 && bg <= 6) || bg === 8) return 'dark';
  return 'light';
}

/**
 * Resolve the user-facing theme. `none` disables colors entirely (chalk.level=0).
 * `--no-color` always wins. `auto` consults COLORFGBG; falls back to 'dark'.
 */
export function resolveTheme(
  configured: ThemeMode,
  options: ResolveThemeOptions = {},
): ResolvedTheme {
  if (options.noColor) return 'none';
  if (configured === 'none') return 'none';
  if (configured === 'dark' || configured === 'light') return configured;
  const detected = detectTerminalTheme(options.env);
  return detected === 'unknown' ? 'dark' : detected;
}

/**
 * Apply the resolved theme globally by adjusting chalk's color level.
 * Returns a themed Chalk instance whose `.level` matches the resolved theme so
 * callers can rely on a single instance instead of mutating the global one.
 */
export function applyTheme(theme: ResolvedTheme): ChalkInstance {
  if (theme === 'none') {
    chalk.level = 0;
    return new Chalk({ level: 0 });
  }
  return chalk;
}

/**
 * Build a themed chalk instance without mutating the global `chalk`. Useful in
 * tests and in code paths that want to coexist with other chalk consumers.
 */
export function themedChalk(theme: ResolvedTheme): ChalkInstance {
  return theme === 'none' ? new Chalk({ level: 0 }) : new Chalk();
}
