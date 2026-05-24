import { describe, expect, it } from 'vitest';
import { buildWatcher } from './watch';

describe('buildWatcher', () => {
  it('rejects --interval values below the 5s floor with an actionable error', () => {
    expect(() => buildWatcher('/tmp', { interval: '500ms' })).toThrow(
      /below the 5s minimum/,
    );
  });

  it('rejects malformed --interval values', () => {
    expect(() => buildWatcher('/tmp', { interval: 'soon' })).toThrow(
      /Invalid --interval/,
    );
  });

  it('accepts a parseable interval and returns a watcher handle', () => {
    const w = buildWatcher(
      '/tmp',
      { interval: '30s' },
      {
        scheduleTimer: () => () => {},
        watchFiles: () => () => {},
        fetchOverview: async () => ({
          branches: [],
          truncated: false,
          cachedAt: new Date(0).toISOString(),
        }),
        detectActiveOperation: async () => 'none',
        ghAuthOk: async () => true,
        getOriginShas: async () => new Map(),
        getCurrentBranch: async () => null,
      },
    );
    expect(typeof w.start).toBe('function');
    expect(typeof w.stop).toBe('function');
    expect(typeof w.pollOnce).toBe('function');
  });
});
