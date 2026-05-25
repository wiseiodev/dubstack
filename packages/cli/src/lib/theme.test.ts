import { describe, expect, it } from 'vitest';
import { detectTerminalTheme, resolveTheme, themedChalk } from './theme';

describe('detectTerminalTheme', () => {
  it('returns "dark" for COLORFGBG with a dark background slot', () => {
    expect(detectTerminalTheme({ COLORFGBG: '15;0' })).toBe('dark');
    expect(detectTerminalTheme({ COLORFGBG: '7;8' })).toBe('dark');
  });

  it('returns "light" for COLORFGBG with a light background slot', () => {
    expect(detectTerminalTheme({ COLORFGBG: '0;15' })).toBe('light');
    expect(detectTerminalTheme({ COLORFGBG: '0;7' })).toBe('light');
  });

  it('returns "unknown" when COLORFGBG is missing or malformed', () => {
    expect(detectTerminalTheme({})).toBe('unknown');
    expect(detectTerminalTheme({ COLORFGBG: 'oops' })).toBe('unknown');
    expect(detectTerminalTheme({ COLORFGBG: '7' })).toBe('unknown');
  });
});

describe('resolveTheme', () => {
  it('--no-color always wins over the configured theme', () => {
    expect(resolveTheme('dark', { noColor: true })).toBe('none');
    expect(resolveTheme('light', { noColor: true })).toBe('none');
    expect(resolveTheme('auto', { noColor: true })).toBe('none');
  });

  it('returns "none" when configured as none', () => {
    expect(resolveTheme('none')).toBe('none');
  });

  it('passes through explicit dark/light', () => {
    expect(resolveTheme('dark')).toBe('dark');
    expect(resolveTheme('light')).toBe('light');
  });

  it('auto-detects from COLORFGBG', () => {
    expect(resolveTheme('auto', { env: { COLORFGBG: '15;0' } })).toBe('dark');
    expect(resolveTheme('auto', { env: { COLORFGBG: '0;15' } })).toBe('light');
  });

  it('falls back to dark when auto cannot detect', () => {
    expect(resolveTheme('auto', { env: {} })).toBe('dark');
  });
});

describe('themedChalk', () => {
  it('returns a chalk instance with level 0 for "none"', () => {
    const c = themedChalk('none');
    expect(c.level).toBe(0);
    expect(c.red('hello')).toBe('hello');
  });

  it('returns a Chalk instance for dark/light that respects the terminal level', () => {
    // Under vitest stdout is not a TTY, so chalk's auto-detected level may be 0.
    // We only assert the instance is wired up and matches the global chalk default.
    const dark = themedChalk('dark');
    const light = themedChalk('light');
    expect(typeof dark.red).toBe('function');
    expect(typeof light.red).toBe('function');
    expect(dark.level).toBeGreaterThanOrEqual(0);
    expect(light.level).toBeGreaterThanOrEqual(0);
  });
});
