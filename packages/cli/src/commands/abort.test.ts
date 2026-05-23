import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DubError } from '../lib/errors';
import { rebaseAbort } from '../lib/git';
import {
  clearRestackProgress,
  detectActiveOperation,
  hasGitRebaseInProgress,
} from '../lib/operation-state';
import { clearCleanupJournal } from '../lib/sync/journal';
import { abortCommand } from './abort';

vi.mock('../lib/operation-state');
vi.mock('../lib/git');
vi.mock('../lib/sync/journal');

describe('abort command', () => {
  const cwd = '/tmp/repo';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(rebaseAbort).mockResolvedValue(undefined);
    vi.mocked(clearRestackProgress).mockResolvedValue(undefined);
    vi.mocked(clearCleanupJournal).mockResolvedValue(undefined);
    vi.mocked(hasGitRebaseInProgress).mockResolvedValue(false);
  });

  it('throws when no operation is active', async () => {
    vi.mocked(detectActiveOperation).mockResolvedValue('none');

    await expect(abortCommand(cwd)).rejects.toThrow(DubError);
    await expect(abortCommand(cwd)).rejects.toThrow('No operation');
  });

  it('aborts a generic rebase operation', async () => {
    vi.mocked(detectActiveOperation).mockResolvedValue('rebase');
    vi.mocked(hasGitRebaseInProgress).mockResolvedValue(true);

    const result = await abortCommand(cwd);

    expect(rebaseAbort).toHaveBeenCalledWith(cwd);
    expect(clearRestackProgress).not.toHaveBeenCalled();
    expect(result.aborted).toBe('rebase');
  });

  it('aborts restack and clears progress metadata', async () => {
    vi.mocked(detectActiveOperation).mockResolvedValue('restack');
    vi.mocked(hasGitRebaseInProgress).mockResolvedValue(true);

    const result = await abortCommand(cwd);

    expect(rebaseAbort).toHaveBeenCalledWith(cwd);
    expect(clearRestackProgress).toHaveBeenCalledWith(cwd);
    expect(result.aborted).toBe('restack');
  });

  it('aborts a pending cleanup by clearing the journal', async () => {
    vi.mocked(detectActiveOperation).mockResolvedValue('cleanup');
    vi.mocked(hasGitRebaseInProgress).mockResolvedValue(false);

    const result = await abortCommand(cwd);

    expect(clearCleanupJournal).toHaveBeenCalledWith(cwd);
    expect(rebaseAbort).not.toHaveBeenCalled();
    expect(clearRestackProgress).not.toHaveBeenCalled();
    expect(result.aborted).toBe('cleanup');
  });
});
