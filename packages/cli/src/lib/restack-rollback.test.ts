import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DubError } from './errors';

vi.mock('./git.js', () => ({
  checkoutBranch: vi.fn(),
  forceBranchTo: vi.fn(),
  rebaseAbort: vi.fn(),
}));

vi.mock('./operation-state.js', () => ({
  clearRestackProgress: vi.fn(),
  hasGitRebaseInProgress: vi.fn(),
}));

vi.mock('./state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./state.js')>();
  return {
    ...actual,
    writeState: vi.fn(),
  };
});

vi.mock('./undo-log.js', () => ({
  clearUndoEntry: vi.fn(),
  readUndoEntry: vi.fn(),
}));

import { checkoutBranch, forceBranchTo, rebaseAbort } from './git';
import {
  clearRestackProgress,
  hasGitRebaseInProgress,
} from './operation-state';
import { rollbackRestack } from './restack-rollback';
import { writeState } from './state';
import { clearUndoEntry, readUndoEntry } from './undo-log';

const mockReadUndoEntry = readUndoEntry as ReturnType<typeof vi.fn>;
const mockHasGitRebaseInProgress = hasGitRebaseInProgress as ReturnType<
  typeof vi.fn
>;
const mockRebaseAbort = rebaseAbort as ReturnType<typeof vi.fn>;
const mockCheckoutBranch = checkoutBranch as ReturnType<typeof vi.fn>;
const mockForceBranchTo = forceBranchTo as ReturnType<typeof vi.fn>;
const mockWriteState = writeState as ReturnType<typeof vi.fn>;
const mockClearUndoEntry = clearUndoEntry as ReturnType<typeof vi.fn>;
const mockClearRestackProgress = clearRestackProgress as ReturnType<
  typeof vi.fn
>;

const previousState = { stacks: [] } as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('rollbackRestack', () => {
  it('restores branch tips, aborts in-progress rebase, and clears state', async () => {
    mockReadUndoEntry.mockResolvedValue({
      operation: 'restack',
      timestamp: '2026-05-23T00:00:00Z',
      previousBranch: 'main',
      previousState,
      branchTips: {
        main: 'sha-main',
        'feat/a': 'sha-a',
        'feat/b': 'sha-b',
      },
      createdBranches: [],
    });
    mockHasGitRebaseInProgress.mockResolvedValue(true);

    const result = await rollbackRestack('/repo');

    expect(mockRebaseAbort).toHaveBeenCalledWith('/repo');
    expect(mockCheckoutBranch).toHaveBeenCalledWith('main', '/repo');
    expect(mockForceBranchTo).toHaveBeenCalledWith('feat/a', 'sha-a', '/repo');
    expect(mockForceBranchTo).toHaveBeenCalledWith('feat/b', 'sha-b', '/repo');
    expect(mockForceBranchTo).toHaveBeenCalledWith('main', 'sha-main', '/repo');
    expect(mockWriteState).toHaveBeenCalledWith(previousState, '/repo');
    expect(mockClearUndoEntry).toHaveBeenCalledWith('/repo');
    expect(mockClearRestackProgress).toHaveBeenCalledWith('/repo');
    expect(result).toEqual({ branchesRestored: 3, previousBranch: 'main' });
  });

  it('skips rebase abort when no rebase is in progress', async () => {
    mockReadUndoEntry.mockResolvedValue({
      operation: 'restack',
      timestamp: '2026-05-23T00:00:00Z',
      previousBranch: 'main',
      previousState,
      branchTips: { main: 'sha-main' },
      createdBranches: [],
    });
    mockHasGitRebaseInProgress.mockResolvedValue(false);

    await rollbackRestack('/repo');

    expect(mockRebaseAbort).not.toHaveBeenCalled();
  });

  it('throws DubError with recovery hints when last undo is not a restack', async () => {
    mockReadUndoEntry.mockResolvedValue({
      operation: 'create',
      timestamp: '2026-05-23T00:00:00Z',
      previousBranch: 'main',
      previousState,
      branchTips: {},
      createdBranches: ['feat/a'],
    });

    await expect(rollbackRestack('/repo')).rejects.toMatchObject({
      message: expect.stringContaining('not from a restack'),
    });
    await expect(rollbackRestack('/repo')).rejects.toBeInstanceOf(DubError);
  });
});
