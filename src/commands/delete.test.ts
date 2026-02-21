import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteTrackedBranch, getDeletePreview } from '../lib/delete';
import { DubError } from '../lib/errors';
import { getCurrentBranch } from '../lib/git';
import { deleteCommand } from './delete';

vi.mock('../lib/git');
vi.mock('../lib/delete');

describe('delete command', () => {
  const cwd = '/tmp/repo';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDeletePreview).mockResolvedValue({
      branch: 'feat/a',
      targets: ['feat/a'],
    });
    vi.mocked(deleteTrackedBranch).mockResolvedValue({
      deleted: ['feat/a'],
      reparented: [],
    });
  });

  it('defaults to current branch when no branch argument is provided', async () => {
    vi.mocked(getCurrentBranch).mockResolvedValue('feat/a');

    await deleteCommand(cwd, undefined, { force: true, quiet: true });

    expect(deleteTrackedBranch).toHaveBeenCalledWith(cwd, {
      branch: 'feat/a',
      upstack: false,
      downstack: false,
      force: true,
    });
  });

  it('forwards upstack/downstack/force options', async () => {
    vi.mocked(getCurrentBranch).mockResolvedValue('feat/current');

    await deleteCommand(cwd, 'feat/a', {
      upstack: true,
      downstack: true,
      force: true,
      quiet: true,
    });

    expect(deleteTrackedBranch).toHaveBeenCalledWith(cwd, {
      branch: 'feat/a',
      upstack: true,
      downstack: true,
      force: true,
    });
  });

  it('throws in non-interactive mode without --force or --quiet', async () => {
    vi.mocked(getCurrentBranch).mockResolvedValue('feat/a');

    await expect(
      deleteCommand(cwd, 'feat/a', { interactive: false }),
    ).rejects.toThrow(DubError);
    await expect(
      deleteCommand(cwd, 'feat/a', { interactive: false }),
    ).rejects.toThrow('--force');
  });
});
