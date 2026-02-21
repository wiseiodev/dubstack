import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/github.js', () => ({
  checkGhAuth: vi.fn(),
  ensureGhInstalled: vi.fn(),
  openPrInBrowser: vi.fn(),
}));

import { checkGhAuth, ensureGhInstalled, openPrInBrowser } from '../lib/github';
import { pr } from './pr';

const mockEnsureGhInstalled = ensureGhInstalled as ReturnType<typeof vi.fn>;
const mockCheckGhAuth = checkGhAuth as ReturnType<typeof vi.fn>;
const mockOpenPrInBrowser = openPrInBrowser as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockEnsureGhInstalled.mockResolvedValue(undefined);
  mockCheckGhAuth.mockResolvedValue(undefined);
  mockOpenPrInBrowser.mockResolvedValue(undefined);
});

describe('pr', () => {
  it('opens the current branch PR when no branch is provided', async () => {
    await pr('/repo');
    expect(mockEnsureGhInstalled).toHaveBeenCalledTimes(1);
    expect(mockCheckGhAuth).toHaveBeenCalledTimes(1);
    expect(mockOpenPrInBrowser).toHaveBeenCalledWith('/repo', undefined);
  });

  it('opens the provided branch PR when a branch is provided', async () => {
    await pr('/repo', 'feat/a');
    expect(mockOpenPrInBrowser).toHaveBeenCalledWith('/repo', 'feat/a');
  });
});
