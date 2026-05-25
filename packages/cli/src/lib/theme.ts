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
 * Apply the resolved theme by mutating the process-wide `chalk.level` when the
 * theme is `none`. The mutation is intentional — every CLI module imports the
 * global `chalk` directly, so flipping the level once at program startup is the
 * only practical way to disable colors across all of them without a refactor.
 *
 * `dark` and `light` currently leave chalk's auto-detected level untouched.
 * The `ThemeMode` API accepts both for forward-compat: a future change can
 * introduce a palette swap (e.g. `themeColorFor('dark', { dark, light })`)
 * without breaking the on-disk config or the `dub config theme` UX. Until
 * that lands, `dark`/`light`/`auto` produce identical output and only `none`
 * has an observable effect — flagged here so reviewers know the limitation
 * is recorded rather than overlooked.
 *
 * Tests must never call this function: it leaks across the worker. Use
 * `themedChalk()` instead when you need a non-global Chalk instance.
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
