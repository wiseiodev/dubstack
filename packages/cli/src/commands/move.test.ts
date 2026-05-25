import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/git.js', async () => {
  const actual =
    await vi.importActual<typeof import('../lib/git.js')>('../lib/git.js');
  return {
    ...actual,
    branchExists: vi.fn(),
    getBranchTip: vi.fn(),
    getCurrentBranch: vi.fn(),
    isWorkingTreeClean: vi.fn(),
    listWorktreeCheckouts: vi.fn(),
  };
});

vi.mock('../lib/github.js', () => ({
  checkGhAuth: vi.fn(),
  ensureGhInstalled: vi.fn(),
  getBranchPrSyncInfo: vi.fn(),
  retargetPrBase: vi.fn(),
}));

vi.mock('../lib/state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/state.js')>();
  return {
    ...actual,
    readState: vi.fn(),
    writeState: vi.fn(),
  };
});

vi.mock('../lib/cleanup-journal.js', () => ({
  startCleanupJournal: vi.fn(),
  appendCleanupOperation: vi.fn(),
  clearCleanupJournal: vi.fn(),
}));

vi.mock('../lib/undo-log.js', () => ({
  saveUndoEntry: vi.fn(),
}));

vi.mock('./restack.js', () => ({
  restack: vi.fn(),
}));

import {
  appendCleanupOperation,
  clearCleanupJournal,
  startCleanupJournal,
} from '../lib/cleanup-journal';
import {
  branchExists,
  getBranchTip,
  getCurrentBranch,
  isWorkingTreeClean,
  listWorktreeCheckouts,
} from '../lib/git';
import {
  checkGhAuth,
  ensureGhInstalled,
  getBranchPrSyncInfo,
  retargetPrBase,
} from '../lib/github';
import type { Branch, DubState } from '../lib/state';
import { readState, writeState } from '../lib/state';
import { saveUndoEntry } from '../lib/undo-log';
import { move } from './move';
import { restack } from './restack';

const cwd = '/tmp/repo';

interface BranchSpec {
  name: string;
  parent: string | null;
  type?: 'root';
  pr_number?: number;
}

function makeState(specs: BranchSpec[]): DubState {
  const branches: Branch[] = specs.map((s) => ({
    name: s.name,
    parent: s.parent,
    ...(s.type === 'root' ? { type: 'root' as const } : {}),
    pr_number: s.pr_number ?? null,
    pr_link: s.pr_number != null ? `https://x/${s.pr_number}` : null,
  }));
  return { stacks: [{ id: 'stack-1', branches }] };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isWorkingTreeClean).mockResolvedValue(true);
  vi.mocked(listWorktreeCheckouts).mockResolvedValue(new Map());
  vi.mocked(branchExists).mockResolvedValue(true);
  vi.mocked(getCurrentBranch).mockResolvedValue('main');
  vi.mocked(getBranchTip).mockImplementation(async (name) => `sha:${name}`);
  vi.mocked(writeState).mockResolvedValue(undefined);
  vi.mocked(startCleanupJournal).mockResolvedValue({
    version: 1,
    started_at: '2026-05-24T00:00:00Z',
    operations: [],
  });
  vi.mocked(appendCleanupOperation).mockResolvedValue(undefined);
  vi.mocked(clearCleanupJournal).mockResolvedValue(undefined);
  vi.mocked(restack).mockResolvedValue({ status: 'success', rebased: [] });
  vi.mocked(saveUndoEntry).mockResolvedValue(undefined);
});

describe('move command (unit)', () => {
  it('journals retarget op and calls gh pr edit when the moved branch has an open PR', async () => {
    vi.mocked(readState).mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/auth-base', parent: 'main' },
        { name: 'feat/auth-login', parent: 'feat/auth-base', pr_number: 11 },
        { name: 'feat/inserted', parent: 'main', pr_number: 22 },
      ]),
    );
    vi.mocked(getBranchPrSyncInfo).mockImplementation(async (name) => ({
      state: 'OPEN',
      baseRefName: name === 'feat/inserted' ? 'main' : 'feat/auth-base',
    }));

    const result = await move(cwd, 'feat/inserted', {
      before: 'feat/auth-login',
    });

    expect(result.noOp).toBe(false);
    expect(result.position).toBe('before');
    expect(ensureGhInstalled).toHaveBeenCalled();
    expect(checkGhAuth).toHaveBeenCalled();
    // Both branches were reparented and both have PRs whose base must change.
    expect(retargetPrBase).toHaveBeenCalledTimes(2);
    expect(retargetPrBase).toHaveBeenCalledWith(
      'feat/auth-login',
      'feat/inserted',
      cwd,
    );
    expect(retargetPrBase).toHaveBeenCalledWith(
      'feat/inserted',
      'feat/auth-base',
      cwd,
    );
    expect(result.retargeted.sort()).toEqual(
      ['feat/auth-login', 'feat/inserted'].sort(),
    );

    // Journal recorded 2 reparents + 2 retargets.
    const reparentCalls = vi
      .mocked(appendCleanupOperation)
      .mock.calls.filter(([, , op]) => op.type === 'reparent');
    const retargetCalls = vi
      .mocked(appendCleanupOperation)
      .mock.calls.filter(([, , op]) => op.type === 'retarget');
    expect(reparentCalls).toHaveLength(2);
    expect(retargetCalls).toHaveLength(2);

    // Journal cleared on success.
    expect(clearCleanupJournal).toHaveBeenCalled();
    // Undo entry written so `dub undo` can roll back.
    expect(saveUndoEntry).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'move' }),
      cwd,
    );
  });

  it('skips gh entirely when no affected branch has a PR', async () => {
    vi.mocked(readState).mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/auth-base', parent: 'main' },
        { name: 'feat/auth-login', parent: 'feat/auth-base' },
        { name: 'feat/inserted', parent: 'feat/auth-base' },
      ]),
    );

    await move(cwd, 'feat/inserted', { before: 'feat/auth-login' });

    expect(ensureGhInstalled).not.toHaveBeenCalled();
    expect(checkGhAuth).not.toHaveBeenCalled();
    expect(retargetPrBase).not.toHaveBeenCalled();
  });

  it('refuses to mutate state when the working tree is dirty', async () => {
    vi.mocked(isWorkingTreeClean).mockResolvedValue(false);
    vi.mocked(readState).mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
        { name: 'feat/b', parent: 'feat/a' },
      ]),
    );

    await expect(
      move(cwd, 'feat/b', { before: 'feat/a' }),
    ).rejects.toThrowError(/Working tree has uncommitted changes/);

    expect(startCleanupJournal).not.toHaveBeenCalled();
    expect(writeState).not.toHaveBeenCalled();
  });

  it('leaves the cleanup journal in place when a retarget fails so dub continue can resume', async () => {
    vi.mocked(readState).mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/auth-base', parent: 'main' },
        { name: 'feat/auth-login', parent: 'feat/auth-base', pr_number: 11 },
        { name: 'feat/inserted', parent: 'feat/auth-base' },
      ]),
    );
    vi.mocked(getBranchPrSyncInfo).mockResolvedValue({
      state: 'OPEN',
      baseRefName: 'feat/auth-base',
    });
    vi.mocked(retargetPrBase).mockRejectedValueOnce(new Error('boom'));

    await expect(
      move(cwd, 'feat/inserted', { before: 'feat/auth-login' }),
    ).rejects.toThrowError(/boom/);

    expect(clearCleanupJournal).not.toHaveBeenCalled();
    // State should already be written (so retarget replay finds the desired
    // parent pointers).
    expect(writeState).toHaveBeenCalled();
  });

  it('propagates a restack conflict but still saves the move undo entry', async () => {
    vi.mocked(readState).mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/auth-base', parent: 'main' },
        { name: 'feat/auth-login', parent: 'feat/auth-base' },
        { name: 'feat/inserted', parent: 'main' },
      ]),
    );
    vi.mocked(restack).mockResolvedValue({
      status: 'conflict',
      rebased: [],
      conflictBranch: 'feat/auth-login',
    });

    const result = await move(cwd, 'feat/inserted', {
      before: 'feat/auth-login',
    });

    expect(result.conflictBranch).toBe('feat/auth-login');
    // Move's own undo entry must exist so the user can roll back the whole
    // move (state + branch tips) once they resolve the conflict.
    expect(saveUndoEntry).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'move' }),
      cwd,
    );
    // Restack must be told NOT to overwrite the move undo entry.
    expect(restack).toHaveBeenCalledWith(cwd, { skipUndoEntry: true });
    // Cleanup journal already cleared (state + retargets done before restack).
    expect(clearCleanupJournal).toHaveBeenCalled();
  });
});
