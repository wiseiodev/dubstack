import { beforeEach, describe, expect, it, vi } from 'vitest';
import { branchExists, getCurrentBranch } from '../lib/git';
import { trackBranch } from '../lib/track';
import { track } from './track';

vi.mock('../lib/git');
vi.mock('../lib/track');

describe('track command', () => {
  const cwd = '/tmp/repo';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(branchExists).mockResolvedValue(false);
    vi.mocked(trackBranch).mockResolvedValue({
      branch: 'feat/a',
      parent: 'main',
      status: 'tracked',
      dryRun: false,
    });
  });

  it('tracks current branch when no branch arg is provided', async () => {
    vi.mocked(getCurrentBranch).mockResolvedValue('feat/a');
    vi.mocked(branchExists).mockImplementation(async (name) => name === 'main');

    await track(cwd, undefined, { interactive: false });

    expect(trackBranch).toHaveBeenCalledWith(cwd, {
      branch: 'feat/a',
      parent: 'main',
      dryRun: false,
    });
  });

  it('tracks an explicit branch using current branch as parent hint', async () => {
    vi.mocked(getCurrentBranch).mockResolvedValue('feat/base');
    vi.mocked(branchExists).mockImplementation(async (name) => name === 'main');

    await track(cwd, 'feat/a', { interactive: false });

    expect(trackBranch).toHaveBeenCalledWith(cwd, {
      branch: 'feat/a',
      parent: 'feat/base',
      dryRun: false,
    });
  });

  it('uses explicit --parent when provided', async () => {
    vi.mocked(getCurrentBranch).mockResolvedValue('feat/a');

    await track(cwd, 'feat/a', { parent: 'develop', interactive: false });

    expect(trackBranch).toHaveBeenCalledWith(cwd, {
      branch: 'feat/a',
      parent: 'develop',
      dryRun: false,
    });
  });
});
