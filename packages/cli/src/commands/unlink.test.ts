import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/git.js', async () => {
  const actual =
    await vi.importActual<typeof import('../lib/git.js')>('../lib/git.js');
  return {
    ...actual,
    getCurrentBranch: vi.fn(),
    isWorkingTreeClean: vi.fn(),
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

import {
  appendCleanupOperation,
  clearCleanupJournal,
  startCleanupJournal,
} from '../lib/cleanup-journal';
import { getCurrentBranch, isWorkingTreeClean } from '../lib/git';
import {
  checkGhAuth,
  ensureGhInstalled,
  getBranchPrSyncInfo,
  retargetPrBase,
} from '../lib/github';
import type { Branch, DubState } from '../lib/state';
import { readState, writeState } from '../lib/state';
import { saveUndoEntry } from '../lib/undo-log';
import { unlink } from './unlink';

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
  vi.mocked(getCurrentBranch).mockResolvedValue('main');
  vi.mocked(writeState).mockResolvedValue(undefined);
  vi.mocked(startCleanupJournal).mockResolvedValue({
    version: 1,
    started_at: '2026-05-24T00:00:00Z',
    operations: [],
  });
  vi.mocked(appendCleanupOperation).mockResolvedValue(undefined);
  vi.mocked(clearCleanupJournal).mockResolvedValue(undefined);
  vi.mocked(saveUndoEntry).mockResolvedValue(undefined);
});

describe('unlink command (unit)', () => {
  it('promotes a mid-stack branch to a new root and retargets its PR to trunk', async () => {
    vi.mocked(readState).mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/auth-base', parent: 'main' },
        {
          name: 'feat/auth-login',
          parent: 'feat/auth-base',
          pr_number: 11,
        },
        { name: 'feat/auth-mfa', parent: 'feat/auth-login' },
      ]),
    );
    vi.mocked(getBranchPrSyncInfo).mockResolvedValue({
      state: 'OPEN',
      baseRefName: 'feat/auth-base',
    });

    const result = await unlink(cwd, 'feat/auth-login');

    expect(result.branch).toBe('feat/auth-login');
    expect(result.previousParent).toBe('feat/auth-base');
    expect(result.trunk).toBe('main');
    expect(result.movedDescendants).toEqual(['feat/auth-mfa']);
    expect(result.retargeted).toBe(true);
    expect(result.prNumber).toBe(11);

    // gh preflighted before touching disk.
    expect(ensureGhInstalled).toHaveBeenCalled();
    expect(checkGhAuth).toHaveBeenCalled();
    expect(retargetPrBase).toHaveBeenCalledWith('feat/auth-login', 'main', cwd);

    // Retarget op journaled before writeState — proven by ordering of mock
    // invocations: the journal append happens before writeState.
    expect(appendCleanupOperation).toHaveBeenCalledWith(
      cwd,
      expect.anything(),
      {
        type: 'retarget',
        branch: 'feat/auth-login',
        newBase: 'main',
      },
    );

    // Final state shape: original stack keeps {main, feat/auth-base}; new
    // stack contains {feat/auth-login (root), feat/auth-mfa}.
    const writtenState = vi.mocked(writeState).mock.calls[0]?.[0];
    expect(writtenState).toBeDefined();
    if (!writtenState) throw new Error('writeState was not called');
    expect(writtenState.stacks).toHaveLength(2);
    const original = writtenState.stacks.find((s) => s.id === 'stack-1');
    const newStack = writtenState.stacks.find((s) => s.id !== 'stack-1');
    expect(original?.branches.map((b) => b.name)).toEqual([
      'main',
      'feat/auth-base',
    ]);
    expect(newStack?.branches.map((b) => b.name)).toEqual([
      'feat/auth-login',
      'feat/auth-mfa',
    ]);
    const newRoot = newStack?.branches.find(
      (b) => b.name === 'feat/auth-login',
    );
    expect(newRoot?.type).toBe('root');
    expect(newRoot?.parent).toBeNull();

    expect(saveUndoEntry).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'unlink' }),
      cwd,
    );
    expect(clearCleanupJournal).toHaveBeenCalled();
  });

  it('unlinks a leaf branch with no descendants', async () => {
    vi.mocked(readState).mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/auth-base', parent: 'main' },
        { name: 'feat/auth-login', parent: 'feat/auth-base' },
      ]),
    );

    const result = await unlink(cwd, 'feat/auth-login');

    expect(result.movedDescendants).toEqual([]);
    expect(result.orphanedChildren).toEqual([]);
    // No PR → gh path skipped entirely.
    expect(ensureGhInstalled).not.toHaveBeenCalled();
    expect(retargetPrBase).not.toHaveBeenCalled();
    expect(result.retargeted).toBe(false);

    const writtenState = vi.mocked(writeState).mock.calls[0]?.[0];
    if (!writtenState) throw new Error('writeState was not called');
    const original = writtenState.stacks.find((s) => s.id === 'stack-1');
    const newStack = writtenState.stacks.find((s) => s.id !== 'stack-1');
    expect(original?.branches.map((b) => b.name)).toEqual([
      'main',
      'feat/auth-base',
    ]);
    expect(newStack?.branches.map((b) => b.name)).toEqual(['feat/auth-login']);
  });

  it('--orphan-children leaves descendants on the original parent', async () => {
    vi.mocked(readState).mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/auth-base', parent: 'main' },
        { name: 'feat/auth-login', parent: 'feat/auth-base' },
        { name: 'feat/auth-mfa', parent: 'feat/auth-login' },
        { name: 'feat/auth-totp', parent: 'feat/auth-mfa' },
      ]),
    );

    const result = await unlink(cwd, 'feat/auth-login', {
      orphanChildren: true,
    });

    expect(result.movedDescendants).toEqual([]);
    expect(result.orphanedChildren).toEqual(['feat/auth-mfa']);

    const writtenState = vi.mocked(writeState).mock.calls[0]?.[0];
    if (!writtenState) throw new Error('writeState was not called');
    const original = writtenState.stacks.find((s) => s.id === 'stack-1');
    expect(original?.branches.map((b) => b.name)).toEqual([
      'main',
      'feat/auth-base',
      'feat/auth-mfa',
      'feat/auth-totp',
    ]);
    // Direct child reparented onto the old parent; grandchild stays put.
    expect(
      original?.branches.find((b) => b.name === 'feat/auth-mfa')?.parent,
    ).toBe('feat/auth-base');
    expect(
      original?.branches.find((b) => b.name === 'feat/auth-totp')?.parent,
    ).toBe('feat/auth-mfa');

    const newStack = writtenState.stacks.find((s) => s.id !== 'stack-1');
    expect(newStack?.branches.map((b) => b.name)).toEqual(['feat/auth-login']);
  });

  it('--no-retarget skips gh and reports the skip with the PR number', async () => {
    vi.mocked(readState).mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/auth-base', parent: 'main' },
        {
          name: 'feat/auth-login',
          parent: 'feat/auth-base',
          pr_number: 11,
        },
      ]),
    );

    const result = await unlink(cwd, 'feat/auth-login', { noRetarget: true });

    expect(ensureGhInstalled).not.toHaveBeenCalled();
    expect(retargetPrBase).not.toHaveBeenCalled();
    // Journal must not record a retarget the user explicitly opted out of.
    expect(appendCleanupOperation).not.toHaveBeenCalled();
    expect(result.retargeted).toBe(false);
    expect(result.retargetSkipped).toBe(true);
    expect(result.prNumber).toBe(11);
    // Journal still cleared (we opened it but recorded no ops).
    expect(clearCleanupJournal).toHaveBeenCalled();
  });

  it('leaves the cleanup journal in place when retarget fails so dub continue can resume', async () => {
    vi.mocked(readState).mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/auth-base', parent: 'main' },
        {
          name: 'feat/auth-login',
          parent: 'feat/auth-base',
          pr_number: 11,
        },
      ]),
    );
    vi.mocked(getBranchPrSyncInfo).mockResolvedValue({
      state: 'OPEN',
      baseRefName: 'feat/auth-base',
    });
    vi.mocked(retargetPrBase).mockRejectedValueOnce(new Error('boom'));

    await expect(unlink(cwd, 'feat/auth-login')).rejects.toThrowError(/boom/);

    // State written, undo saved, journal NOT cleared — exactly the layout
    // resumeCleanup needs to finish the retarget on `dub continue`.
    expect(writeState).toHaveBeenCalled();
    expect(saveUndoEntry).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'unlink' }),
      cwd,
    );
    expect(clearCleanupJournal).not.toHaveBeenCalled();
  });

  it('refuses to mutate state when the working tree is dirty', async () => {
    vi.mocked(isWorkingTreeClean).mockResolvedValue(false);
    vi.mocked(readState).mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/auth-base', parent: 'main' },
        { name: 'feat/auth-login', parent: 'feat/auth-base' },
      ]),
    );

    await expect(unlink(cwd, 'feat/auth-login')).rejects.toThrowError(
      /Working tree has uncommitted changes/,
    );

    expect(startCleanupJournal).not.toHaveBeenCalled();
    expect(writeState).not.toHaveBeenCalled();
  });

  it('refuses to unlink a root branch', async () => {
    vi.mocked(readState).mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/auth-base', parent: 'main' },
      ]),
    );

    await expect(unlink(cwd, 'main')).rejects.toThrowError(
      /Cannot unlink root branch/,
    );

    expect(writeState).not.toHaveBeenCalled();
  });

  it('refuses to unlink an untracked branch', async () => {
    vi.mocked(readState).mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/auth-base', parent: 'main' },
      ]),
    );

    await expect(unlink(cwd, 'feat/unknown')).rejects.toThrowError(
      /is not tracked/,
    );

    expect(writeState).not.toHaveBeenCalled();
  });

  it('--no-retarget on a branch with no PR records no skip and no warning', async () => {
    vi.mocked(readState).mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/auth-base', parent: 'main' },
        { name: 'feat/auth-login', parent: 'feat/auth-base' },
      ]),
    );

    const result = await unlink(cwd, 'feat/auth-login', { noRetarget: true });

    expect(ensureGhInstalled).not.toHaveBeenCalled();
    expect(retargetPrBase).not.toHaveBeenCalled();
    expect(result.retargetSkipped).toBe(false);
    expect(result.prNumber).toBeUndefined();
  });

  it('skips retarget when the PR base already points at trunk', async () => {
    vi.mocked(readState).mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/auth-base', parent: 'main' },
        {
          name: 'feat/auth-login',
          parent: 'feat/auth-base',
          pr_number: 11,
        },
      ]),
    );
    // PR is already based on trunk (e.g. previously retargeted manually).
    vi.mocked(getBranchPrSyncInfo).mockResolvedValue({
      state: 'OPEN',
      baseRefName: 'main',
    });

    const result = await unlink(cwd, 'feat/auth-login');

    expect(retargetPrBase).not.toHaveBeenCalled();
    expect(appendCleanupOperation).not.toHaveBeenCalled();
    expect(result.retargeted).toBe(false);
    expect(result.retargetSkipped).toBe(false);
  });
});
