import { describe, expect, it } from 'vitest';
import { formatDuration, parseDuration } from './duration';

describe('parseDuration', () => {
  it('parses bare integers as milliseconds', () => {
    expect(parseDuration('500')).toBe(500);
  });

  it('parses ms, s, m, h units', () => {
    expect(parseDuration('250ms')).toBe(250);
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('5m')).toBe(300_000);
    expect(parseDuration('2h')).toBe(7_200_000);
  });

  it('is case-insensitive and tolerates whitespace', () => {
    expect(parseDuration(' 60S ')).toBe(60_000);
    expect(parseDuration('1H')).toBe(3_600_000);
  });

  it('accepts decimals', () => {
    expect(parseDuration('1.5s')).toBe(1_500);
  });

  it('returns null on malformed input', () => {
    expect(parseDuration('')).toBeNull();
    expect(parseDuration(null)).toBeNull();
    expect(parseDuration(undefined)).toBeNull();
    expect(parseDuration('abc')).toBeNull();
    expect(parseDuration('30x')).toBeNull();
    expect(parseDuration('-5s')).toBeNull();
  });
});

describe('formatDuration', () => {
  it('renders compact unit suffixes', () => {
    expect(formatDuration(250)).toBe('250ms');
    expect(formatDuration(30_000)).toBe('30s');
    expect(formatDuration(300_000)).toBe('5m');
    expect(formatDuration(7_200_000)).toBe('2h');
  });

  it('clamps negative or non-finite to 0s', () => {
    expect(formatDuration(-1)).toBe('0s');
    expect(formatDuration(Number.NaN)).toBe('0s');
  });
});
