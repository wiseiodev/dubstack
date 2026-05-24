import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/git.js', () => ({
  checkoutBranch: vi.fn(),
  fastForwardBranchToRef: vi.fn(),
  fetchBranches: vi.fn(),
  formatWorktreeCheckoutSkipMessage: vi.fn(
    (branch: string, worktreePath: string, command = 'dub sync') =>
      `ℹ Skipped '${branch}' — checked out in ${worktreePath}.\n   Run \`${command}\` from that worktree to update it.`,
  ),
  getCurrentBranch: vi.fn(),
  listWorktreeCheckouts: vi.fn(),
  remoteBranchExists: vi.fn(),
}));

vi.mock('../../src/lib/cleanup-journal.js', () => ({
  startCleanupJournal: vi.fn().mockResolvedValue({
    version: 1,
    started_at: 'mock',
    operations: [],
  }),
  appendCleanupOperation: vi.fn().mockResolvedValue(undefined),
  clearCleanupJournal: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/lib/state.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/lib/state.js')>();
  return {
    ...actual,
    readState: vi.fn(),
    writeState: vi.fn(),
  };
});

vi.mock('../../src/lib/github.js', () => ({
  checkGhAuth: vi.fn(),
  ensureGhInstalled: vi.fn(),
  getBranchPrLifecycleState: vi.fn(),
  getBranchPrSyncInfo: vi.fn(),
  retargetPrBase: vi.fn(),
}));

vi.mock('../../src/commands/restack.js', () => ({
  restack: vi.fn(),
}));

vi.mock('../../src/commands/submit.js', () => ({
  submit: vi.fn(),
}));

import { postMerge } from '../../src/commands/post-merge';
import { restack } from '../../src/commands/restack';
import { submit } from '../../src/commands/submit';
import {
  checkoutBranch,
  fastForwardBranchToRef,
  fetchBranches,
  getCurrentBranch,
  listWorktreeCheckouts,
  remoteBranchExists,
} from '../../src/lib/git';
import {
  checkGhAuth,
  ensureGhInstalled,
  getBranchPrLifecycleState,
  getBranchPrSyncInfo,
  retargetPrBase,
} from '../../src/lib/github';
import type { Branch, DubState } from '../../src/lib/state';
import { readState, writeState } from '../../src/lib/state';

const mockCheckoutBranch = checkoutBranch as ReturnType<typeof vi.fn>;
const mockFastForwardBranchToRef = fastForwardBranchToRef as ReturnType<
  typeof vi.fn
>;
const mockFetchBranches = fetchBranches as ReturnType<typeof vi.fn>;
const mockGetCurrentBranch = getCurrentBranch as ReturnType<typeof vi.fn>;
const mockListWorktreeCheckouts = listWorktreeCheckouts as ReturnType<
  typeof vi.fn
>;
const mockRemoteBranchExists = remoteBranchExists as ReturnType<typeof vi.fn>;
const mockEnsureGhInstalled = ensureGhInstalled as ReturnType<typeof vi.fn>;
const mockCheckGhAuth = checkGhAuth as ReturnType<typeof vi.fn>;
const mockGetBranchPrLifecycleState = getBranchPrLifecycleState as ReturnType<
  typeof vi.fn
>;
const mockGetBranchPrSyncInfo = getBranchPrSyncInfo as ReturnType<typeof vi.fn>;
const mockRetargetPrBase = retargetPrBase as ReturnType<typeof vi.fn>;
const mockReadState = readState as ReturnType<typeof vi.fn>;
const mockWriteState = writeState as ReturnType<typeof vi.fn>;
const mockRestack = restack as ReturnType<typeof vi.fn>;
const mockSubmit = submit as ReturnType<typeof vi.fn>;

interface BranchSpec {
  name: string;
  parent: string | null;
  type?: 'root';
  pr_number?: number | null;
}

function makeStackState(specs: BranchSpec[]): DubState {
  const branches: Branch[] = specs.map((s) => ({
    name: s.name,
    parent: s.parent,
    ...(s.type === 'root' ? { type: 'root' as const } : {}),
    pr_number: s.pr_number ?? null,
    pr_link: s.pr_number != null ? `https://x/${s.pr_number}` : null,
  }));
  return { stacks: [{ id: 'tree-stack', branches }] };
}

/**
 * Wires PR lifecycle + sync mocks from a single map.
 * `mergedBranches`: branches whose PR has been merged.
 *
 * `baseRefName` is snapshotted at setup time (mirrors what GitHub would return
 * before post-merge edits the PR base) so retarget assertions fire whenever
 * state mutation moves a branch's parent away from its original.
 */
function mockPrState(state: DubState, mergedBranches: Set<string>) {
  const originalParent = new Map(
    state.stacks.flatMap((s) =>
      s.branches.map((b) => [b.name, b.parent] as const),
    ),
  );
  const isRoot = new Set(
    state.stacks.flatMap((s) =>
      s.branches.filter((b) => b.type === 'root').map((b) => b.name),
    ),
  );
  mockGetBranchPrLifecycleState.mockImplementation(async (branch: string) => {
    if (isRoot.has(branch)) return 'NONE';
    if (!originalParent.has(branch)) return 'NONE';
    return mergedBranches.has(branch) ? 'MERGED' : 'OPEN';
  });
  mockGetBranchPrSyncInfo.mockImplementation(async (branch: string) => {
    if (isRoot.has(branch) || !originalParent.has(branch))
      return { state: 'NONE', baseRefName: null };
    const base = originalParent.get(branch) ?? null;
    if (mergedBranches.has(branch))
      return { state: 'MERGED', baseRefName: base };
    return { state: 'OPEN', baseRefName: base };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchBranches.mockResolvedValue(undefined);
  mockFastForwardBranchToRef.mockResolvedValue(true);
  mockEnsureGhInstalled.mockResolvedValue(undefined);
  mockCheckGhAuth.mockResolvedValue(undefined);
  mockRemoteBranchExists.mockResolvedValue(true);
  mockListWorktreeCheckouts.mockResolvedValue(new Map());
  mockWriteState.mockResolvedValue(undefined);
  mockRetargetPrBase.mockResolvedValue(undefined);
  mockRestack.mockResolvedValue({ status: 'up-to-date', rebased: [] });
  mockSubmit.mockResolvedValue({
    pushed: [],
    created: [],
    updated: [],
    scope: { kind: 'stack' },
    dryRun: false,
  });
});

describe('postMerge — tree scenarios', () => {
  it('leaf merged: sibling stays put, no reparent, no retarget', async () => {
    // main → feat/leaf-merged (MERGED, leaf)
    //      → feat/leaf-open   (OPEN,   leaf)
    const state = makeStackState([
      { name: 'main', parent: null, type: 'root' },
      { name: 'feat/leaf-merged', parent: 'main', pr_number: 1 },
      { name: 'feat/leaf-open', parent: 'main', pr_number: 2 },
    ]);
    mockReadState.mockResolvedValue(state);
    mockGetCurrentBranch.mockResolvedValue('feat/leaf-open');
    mockPrState(state, new Set(['feat/leaf-merged']));

    const result = await postMerge('/repo', { restack: false, submit: false });

    expect(result.cleaned).toEqual(['feat/leaf-merged']);
    expect(result.reparented).toEqual([]);
    expect(result.retargeted).toEqual([]);
    expect(mockRetargetPrBase).not.toHaveBeenCalled();

    const saved = mockWriteState.mock.calls[0][0] as DubState;
    const names = saved.stacks[0].branches.map((b) => b.name).sort();
    expect(names).toEqual(['feat/leaf-open', 'main']);
    const sibling = saved.stacks[0].branches.find(
      (b) => b.name === 'feat/leaf-open',
    );
    expect(sibling?.parent).toBe('main');
  });

  it('middle merged, single child: child reparented onto grandparent, child PR retargeted', async () => {
    // main → feat/middle (MERGED) → feat/child (OPEN)
    const state = makeStackState([
      { name: 'main', parent: null, type: 'root' },
      { name: 'feat/middle', parent: 'main', pr_number: 1 },
      { name: 'feat/child', parent: 'feat/middle', pr_number: 2 },
    ]);
    mockReadState.mockResolvedValue(state);
    mockGetCurrentBranch.mockResolvedValue('feat/child');
    mockPrState(state, new Set(['feat/middle']));

    const result = await postMerge('/repo', { restack: false, submit: false });

    expect(result.cleaned).toEqual(['feat/middle']);
    expect(result.reparented).toEqual([
      { branch: 'feat/child', parent: 'main' },
    ]);
    expect(result.retargeted).toEqual(['feat/child']);
    expect(mockRetargetPrBase).toHaveBeenCalledTimes(1);
    expect(mockRetargetPrBase).toHaveBeenCalledWith(
      'feat/child',
      'main',
      '/repo',
    );

    const saved = mockWriteState.mock.calls[0][0] as DubState;
    const child = saved.stacks[0].branches.find((b) => b.name === 'feat/child');
    expect(child?.parent).toBe('main');
    expect(
      saved.stacks[0].branches.find((b) => b.name === 'feat/middle'),
    ).toBeUndefined();
  });

  it('middle merged, multiple children: every child reparented + retargeted', async () => {
    // main → feat/middle (MERGED) → feat/a (OPEN), feat/b (OPEN), feat/c (OPEN)
    const state = makeStackState([
      { name: 'main', parent: null, type: 'root' },
      { name: 'feat/middle', parent: 'main', pr_number: 1 },
      { name: 'feat/a', parent: 'feat/middle', pr_number: 2 },
      { name: 'feat/b', parent: 'feat/middle', pr_number: 3 },
      { name: 'feat/c', parent: 'feat/middle', pr_number: 4 },
    ]);
    mockReadState.mockResolvedValue(state);
    mockGetCurrentBranch.mockResolvedValue('feat/a');
    mockPrState(state, new Set(['feat/middle']));

    const result = await postMerge('/repo', { restack: false, submit: false });

    expect(result.cleaned).toEqual(['feat/middle']);
    expect(result.reparented.map((r) => r.branch).sort()).toEqual([
      'feat/a',
      'feat/b',
      'feat/c',
    ]);
    for (const entry of result.reparented) {
      expect(entry.parent).toBe('main');
    }
    expect(result.retargeted).toEqual(['feat/a', 'feat/b', 'feat/c']);

    const retargetCalls = mockRetargetPrBase.mock.calls
      .map((c) => c[0] as string)
      .sort();
    expect(retargetCalls).toEqual(['feat/a', 'feat/b', 'feat/c']);
    for (const call of mockRetargetPrBase.mock.calls) {
      expect(call[1]).toBe('main');
      expect(call[2]).toBe('/repo');
    }

    const saved = mockWriteState.mock.calls[0][0] as DubState;
    for (const name of ['feat/a', 'feat/b', 'feat/c']) {
      const branch = saved.stacks[0].branches.find((b) => b.name === name);
      expect(branch?.parent).toBe('main');
    }
  });

  it('base merged, multi-sibling subtree: siblings reparent to grandparent, grandchildren untouched', async () => {
    // main → feat/base (MERGED)
    //         → feat/sib-a (OPEN) → feat/grand-a (OPEN)
    //         → feat/sib-b (OPEN) → feat/grand-b (OPEN)
    const state = makeStackState([
      { name: 'main', parent: null, type: 'root' },
      { name: 'feat/base', parent: 'main', pr_number: 1 },
      { name: 'feat/sib-a', parent: 'feat/base', pr_number: 2 },
      { name: 'feat/sib-b', parent: 'feat/base', pr_number: 3 },
      { name: 'feat/grand-a', parent: 'feat/sib-a', pr_number: 4 },
      { name: 'feat/grand-b', parent: 'feat/sib-b', pr_number: 5 },
    ]);
    mockReadState.mockResolvedValue(state);
    mockGetCurrentBranch.mockResolvedValue('feat/sib-a');
    mockPrState(state, new Set(['feat/base']));

    const result = await postMerge('/repo', { restack: false, submit: false });

    expect(result.cleaned).toEqual(['feat/base']);
    expect(result.reparented.map((r) => r.branch).sort()).toEqual([
      'feat/sib-a',
      'feat/sib-b',
    ]);
    for (const entry of result.reparented) {
      expect(entry.parent).toBe('main');
    }
    // Only the reparented siblings need their PR base retargeted; grandchildren
    // keep their existing parent so no retarget is requested for them.
    expect(result.retargeted).toEqual(['feat/sib-a', 'feat/sib-b']);
    const retargetedNames = mockRetargetPrBase.mock.calls
      .map((c) => c[0] as string)
      .sort();
    expect(retargetedNames).toEqual(['feat/sib-a', 'feat/sib-b']);

    const saved = mockWriteState.mock.calls[0][0] as DubState;
    const branchMap = new Map(saved.stacks[0].branches.map((b) => [b.name, b]));
    expect(branchMap.get('feat/sib-a')?.parent).toBe('main');
    expect(branchMap.get('feat/sib-b')?.parent).toBe('main');
    expect(branchMap.get('feat/grand-a')?.parent).toBe('feat/sib-a');
    expect(branchMap.get('feat/grand-b')?.parent).toBe('feat/sib-b');
    expect(branchMap.has('feat/base')).toBe(false);
  });

  it('cascade: base + child merged in the same path, intermediate descendants reparented to root', async () => {
    // main → feat/base (MERGED) → feat/child (MERGED) → feat/leaf (OPEN)
    //                            → feat/sib   (OPEN)   ← sibling of feat/child
    const state = makeStackState([
      { name: 'main', parent: null, type: 'root' },
      { name: 'feat/base', parent: 'main', pr_number: 1 },
      { name: 'feat/child', parent: 'feat/base', pr_number: 2 },
      { name: 'feat/leaf', parent: 'feat/child', pr_number: 3 },
      { name: 'feat/sib', parent: 'feat/base', pr_number: 4 },
    ]);
    mockReadState.mockResolvedValue(state);
    mockGetCurrentBranch.mockResolvedValue('feat/leaf');
    mockPrState(state, new Set(['feat/base', 'feat/child']));

    const result = await postMerge('/repo', { restack: false, submit: false });

    expect(result.cleaned.sort()).toEqual(['feat/base', 'feat/child']);
    // Both surviving descendants end up parented on the root.
    const reparentedMap = new Map(
      result.reparented.map((r) => [r.branch, r.parent]),
    );
    expect(reparentedMap.get('feat/leaf')).toBe('main');
    expect(reparentedMap.get('feat/sib')).toBe('main');
    expect(result.retargeted).toEqual(['feat/leaf', 'feat/sib']);

    const retargetedNames = mockRetargetPrBase.mock.calls
      .map((c) => c[0] as string)
      .sort();
    expect(retargetedNames).toEqual(['feat/leaf', 'feat/sib']);
    for (const call of mockRetargetPrBase.mock.calls) {
      expect(call[1]).toBe('main');
    }

    const saved = mockWriteState.mock.calls[0][0] as DubState;
    const branchMap = new Map(saved.stacks[0].branches.map((b) => [b.name, b]));
    expect(branchMap.get('feat/leaf')?.parent).toBe('main');
    expect(branchMap.get('feat/sib')?.parent).toBe('main');
    expect(branchMap.has('feat/base')).toBe(false);
    expect(branchMap.has('feat/child')).toBe(false);
  });

  it('refreshes PR bodies for the surviving tree via a stack-wide submit after cleanup', async () => {
    // PR body refresh is delegated to `dub submit --stack` once cleanup
    // settles. Asserting that submit fires with `stack: true` proves every
    // surviving PR will have its tree-shaped table rewritten by `updateAllPrBodies`.
    const state = makeStackState([
      { name: 'main', parent: null, type: 'root' },
      { name: 'feat/middle', parent: 'main', pr_number: 1 },
      { name: 'feat/a', parent: 'feat/middle', pr_number: 2 },
      { name: 'feat/b', parent: 'feat/middle', pr_number: 3 },
    ]);
    mockReadState.mockResolvedValue(state);
    mockGetCurrentBranch.mockResolvedValue('feat/a');
    mockPrState(state, new Set(['feat/middle']));
    mockSubmit.mockResolvedValue({
      pushed: ['feat/a', 'feat/b'],
      created: [],
      updated: ['feat/a', 'feat/b'],
      scope: { kind: 'stack' },
      dryRun: false,
    });

    const result = await postMerge('/repo');

    expect(result.submitted).toBe(true);
    expect(mockSubmit).toHaveBeenCalledWith('/repo', false, { stack: true });
    expect(result.submittedBranches).toEqual(['feat/a', 'feat/b']);
    // Restack still fires by default so submit operates on a clean tree.
    expect(mockRestack).toHaveBeenCalled();
    // Both reparented branches got their PR bases corrected before the
    // stack-wide submit refreshed their bodies.
    expect(mockRetargetPrBase).toHaveBeenCalledWith('feat/a', 'main', '/repo');
    expect(mockRetargetPrBase).toHaveBeenCalledWith('feat/b', 'main', '/repo');
    // Sanity: at least one of the retarget calls happened before submit so
    // `gh pr edit --base` precedes the body rewrite.
    const firstRetargetOrder =
      mockRetargetPrBase.mock.invocationCallOrder[0] ?? 0;
    const submitOrder = mockSubmit.mock.invocationCallOrder[0] ?? 0;
    expect(firstRetargetOrder).toBeLessThan(submitOrder);
  });

  it('checks out a surviving descendant when cleanup removes the current branch', async () => {
    // main → feat/base (MERGED) → feat/leaf (OPEN)
    // User is sitting on feat/base when the PR merges. Post-merge must land
    // them on feat/leaf (the surviving descendant), not leave them detached.
    const state = makeStackState([
      { name: 'main', parent: null, type: 'root' },
      { name: 'feat/base', parent: 'main', pr_number: 1 },
      { name: 'feat/leaf', parent: 'feat/base', pr_number: 2 },
    ]);
    mockReadState.mockResolvedValue(state);
    mockGetCurrentBranch.mockResolvedValue('feat/base');
    mockPrState(state, new Set(['feat/base']));

    await postMerge('/repo', { submit: false });

    expect(mockCheckoutBranch).toHaveBeenCalledWith('feat/leaf', '/repo');
  });
});
