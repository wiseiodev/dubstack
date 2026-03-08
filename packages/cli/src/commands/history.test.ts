import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/history', () => ({
  readHistory: vi.fn(),
}));

import { readHistory } from '../lib/history';
import { formatHistory, history } from './history';

const mockReadHistory = readHistory as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('history command', () => {
  it('reads history using default limit', async () => {
    mockReadHistory.mockResolvedValue([]);
    await history('/repo');
    expect(mockReadHistory).toHaveBeenCalledWith('/repo', { limit: 20 });
  });

  it('formats empty history output', () => {
    expect(formatHistory({ entries: [] })).toBe('No Dub command history yet.');
  });

  it('formats non-empty history output', () => {
    const output = formatHistory({
      entries: [
        {
          timestamp: '2026-02-21T10:00:00.000Z',
          command: 'dub log',
          status: 'success',
          durationMs: 11,
          output: [],
        },
      ],
    });

    expect(output).toContain('dub log');
    expect(output).toContain('✔');
  });
});
