import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/github.js', () => ({
  openRepositoryInBrowser: vi.fn(),
}));

import { openRepositoryInBrowser } from '../lib/github';
import { repo } from './repo';

const mockOpenRepositoryInBrowser = openRepositoryInBrowser as ReturnType<
  typeof vi.fn
>;

beforeEach(() => {
  vi.clearAllMocks();
  mockOpenRepositoryInBrowser.mockResolvedValue(undefined);
});

describe('repo', () => {
  it('opens the current repository web URL in the browser', async () => {
    await repo('/repo');
    expect(mockOpenRepositoryInBrowser).toHaveBeenCalledWith('/repo');
  });
});
