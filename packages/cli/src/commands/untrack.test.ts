import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DubError } from '../lib/errors';
import { getCurrentBranch } from '../lib/git';
import { getUntrackContext, untrackBranch } from '../lib/untrack';
import { untrack } from './untrack';

vi.mock('../lib/git');
vi.mock('../lib/untrack');

describe('untrack command', () => {
  const cwd = '/tmp/repo';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getUntrackContext).mockResolvedValue({
      branch: 'feat/a',
      descendants: [],
      stack: {
        id: 'stack-1',
        branches: [],
      },
    });
    vi.mocked(untrackBranch).mockResolvedValue({
      removed: ['feat/a'],
      reparented: [],
      dryRun: false,
    });
  });

  it('defaults to current branch when branch arg is omitted', async () => {
    vi.mocked(getCurrentBranch).mockResolvedValue('feat/a');

    await untrack(cwd, undefined, { interactive: false });

    expect(untrackBranch).toHaveBeenCalledWith(cwd, {
      branch: 'feat/a',
      downstack: false,
      dryRun: false,
    });
  });

  it('untracks explicit branch with --downstack', async () => {
    vi.mocked(getCurrentBranch).mockResolvedValue('feat/current');
    vi.mocked(getUntrackContext).mockResolvedValue({
      branch: 'feat/a',
      descendants: ['feat/b'],
      stack: {
        id: 'stack-1',
        branches: [],
      },
    });

    await untrack(cwd, 'feat/a', { downstack: true, interactive: false });

    expect(untrackBranch).toHaveBeenCalledWith(cwd, {
      branch: 'feat/a',
      downstack: true,
      dryRun: false,
    });
  });

  it('throws in non-interactive mode when descendants exist without --downstack', async () => {
    vi.mocked(getCurrentBranch).mockResolvedValue('feat/a');
    vi.mocked(getUntrackContext).mockResolvedValue({
      branch: 'feat/a',
      descendants: ['feat/b'],
      stack: {
        id: 'stack-1',
        branches: [],
      },
    });

    await expect(
      untrack(cwd, 'feat/a', { interactive: false }),
    ).rejects.toThrow(DubError);
    await expect(
      untrack(cwd, 'feat/a', { interactive: false }),
    ).rejects.toThrow('--downstack');
  });
});
