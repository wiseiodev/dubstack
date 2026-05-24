import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendCleanupOperation,
  startCleanupJournal,
} from '../../src/lib/cleanup-journal';
import { resumeCleanup } from '../../src/lib/cleanup-resume';
import * as github from '../../src/lib/github';
import { createTestRepo, gitInRepo } from '../helpers';

let dir: string;
let cleanup: () => Promise<void>;
let ensureGh: ReturnType<typeof vi.spyOn>;
let checkGh: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  const repo = await createTestRepo();
  dir = repo.dir;
  cleanup = repo.cleanup;
  // Retarget replay preflights gh; stub it so tests don't depend on a real
  // gh binary or authenticated user in CI.
  ensureGh = vi.spyOn(github, 'ensureGhInstalled').mockResolvedValue(undefined);
  checkGh = vi.spyOn(github, 'checkGhAuth').mockResolvedValue(undefined);
});

afterEach(async () => {
  ensureGh.mockRestore();
  checkGh.mockRestore();
  await cleanup();
});

function writeState(state: unknown) {
  const statePath = path.join(dir, '.git', 'dubstack', 'state.json');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function readState(): {
  stacks: Array<{
    id: string;
    branches: Array<{ name: string; parent: string | null; type?: 'root' }>;
  }>;
} {
  const statePath = path.join(dir, '.git', 'dubstack', 'state.json');
  return JSON.parse(fs.readFileSync(statePath, 'utf-8'));
}

async function commitFile(name: string, body: string, message: string) {
  fs.writeFileSync(path.join(dir, name), body);
  await gitInRepo(dir, ['add', name]);
  await gitInRepo(dir, ['commit', '-m', message]);
}

describe('resumeCleanup', () => {
  it('replays a journal: reparents a child and deletes the merged middle', async () => {
    // Build trunk → middle → child locally.
    await gitInRepo(dir, ['checkout', '-b', 'middle']);
    await commitFile('mid.txt', 'mid\n', 'feat: mid');
    await gitInRepo(dir, ['checkout', '-b', 'child']);
    await commitFile('child.txt', 'child\n', 'feat: child');
    // Get off `middle` so we can delete it.
    await gitInRepo(dir, ['checkout', 'main']);

    writeState({
      stacks: [
        {
          id: 'stack-1',
          branches: [
            { name: 'main', parent: null, type: 'root' },
            { name: 'middle', parent: 'main', pr_number: null, pr_link: null },
            {
              name: 'child',
              parent: 'middle',
              pr_number: null,
              pr_link: null,
            },
          ],
        },
      ],
    });

    const journal = await startCleanupJournal(dir);
    await appendCleanupOperation(dir, journal, {
      type: 'reparent',
      branch: 'child',
      oldParent: 'middle',
      newParent: 'main',
    });
    await appendCleanupOperation(dir, journal, {
      type: 'delete',
      branch: 'middle',
      reason: 'merged-pr',
    });

    const result = await resumeCleanup(dir);

    expect(result.applied).toHaveLength(2);
    const finalState = readState();
    const branches = finalState.stacks[0].branches;
    expect(branches.find((b) => b.name === 'middle')).toBeUndefined();
    expect(branches.find((b) => b.name === 'child')?.parent).toBe('main');

    // Branch ref must be gone from git too.
    const { stdout: branchList } = await gitInRepo(dir, [
      'branch',
      '--list',
      'middle',
    ]);
    expect(branchList.trim()).toBe('');
  });

  it('drops a ghost state entry when the branch ref is already gone', async () => {
    // Simulate a crash between `git branch -D` and `writeState`: state still
    // points to a branch that no longer exists on disk.
    writeState({
      stacks: [
        {
          id: 'stack-1',
          branches: [
            { name: 'main', parent: null, type: 'root' },
            { name: 'ghost', parent: 'main', pr_number: null, pr_link: null },
            { name: 'child', parent: 'ghost', pr_number: null, pr_link: null },
          ],
        },
      ],
    });
    // No `ghost` branch ref in git.
    const journal = await startCleanupJournal(dir);
    await appendCleanupOperation(dir, journal, {
      type: 'delete',
      branch: 'ghost',
      reason: 'merged-pr',
    });

    const result = await resumeCleanup(dir);
    expect(result.alreadyApplied).toHaveLength(1);

    // State entry must be cleaned even though the git delete was a no-op.
    const finalState = readState();
    const branches = finalState.stacks[0].branches;
    expect(branches.find((b) => b.name === 'ghost')).toBeUndefined();
    // Children of the ghost branch get forwarded to its prior parent so the
    // stack tree stays connected.
    expect(branches.find((b) => b.name === 'child')?.parent).toBe('main');
  });

  it('is idempotent: a second replay with both branches already gone is a no-op', async () => {
    // No branch ref, but state still references it.
    writeState({
      stacks: [
        {
          id: 'stack-1',
          branches: [
            { name: 'main', parent: null, type: 'root' },
            { name: 'child', parent: 'main', pr_number: null, pr_link: null },
          ],
        },
      ],
    });

    const journal = await startCleanupJournal(dir);
    await appendCleanupOperation(dir, journal, {
      type: 'reparent',
      branch: 'child',
      oldParent: 'middle',
      newParent: 'main',
    });
    await appendCleanupOperation(dir, journal, {
      type: 'delete',
      branch: 'middle',
      reason: 'merged-pr',
    });

    const first = await resumeCleanup(dir);
    // Both already-applied (child.parent==='main', middle branch missing).
    expect(first.alreadyApplied).toHaveLength(2);
    expect(first.applied).toHaveLength(0);
  });

  it('clears the journal after a successful replay so subsequent continues are no-ops', async () => {
    writeState({
      stacks: [{ id: 'stack-1', branches: [] }],
    });
    const journal = await startCleanupJournal(dir);
    await appendCleanupOperation(dir, journal, {
      type: 'delete',
      branch: 'never-existed',
      reason: 'merged-pr',
    });

    await resumeCleanup(dir);
    const journalPath = path.join(
      dir,
      '.git',
      'dubstack',
      'cleanup-journal.json',
    );
    expect(fs.existsSync(journalPath)).toBe(false);

    // Second call: nothing to do.
    const second = await resumeCleanup(dir);
    expect(second.applied).toHaveLength(0);
    expect(second.alreadyApplied).toHaveLength(0);
  });

  it('replays a retarget op only when the current PR base differs', async () => {
    writeState({
      stacks: [
        {
          id: 'stack-1',
          branches: [
            { name: 'main', parent: null, type: 'root' },
            { name: 'feat/a', parent: 'main', pr_number: 1, pr_link: null },
            { name: 'feat/b', parent: 'feat/a', pr_number: 2, pr_link: null },
          ],
        },
      ],
    });
    const getInfo = vi
      .spyOn(github, 'getBranchPrSyncInfo')
      .mockResolvedValue({ state: 'OPEN', baseRefName: 'feat/a' });
    const retarget = vi
      .spyOn(github, 'retargetPrBase')
      .mockResolvedValue(undefined);

    const journal = await startCleanupJournal(dir);
    await appendCleanupOperation(dir, journal, {
      type: 'retarget',
      branch: 'feat/b',
      newBase: 'main',
    });

    const result = await resumeCleanup(dir);

    expect(result.applied).toHaveLength(1);
    expect(retarget).toHaveBeenCalledWith('feat/b', 'main', dir);
    expect(getInfo).toHaveBeenCalledWith('feat/b', dir);
    getInfo.mockRestore();
    retarget.mockRestore();
  });

  it('skips a retarget op when the PR is already on the new base', async () => {
    writeState({
      stacks: [
        {
          id: 'stack-1',
          branches: [
            { name: 'main', parent: null, type: 'root' },
            { name: 'feat/b', parent: 'main', pr_number: 2, pr_link: null },
          ],
        },
      ],
    });
    const getInfo = vi
      .spyOn(github, 'getBranchPrSyncInfo')
      .mockResolvedValue({ state: 'OPEN', baseRefName: 'main' });
    const retarget = vi
      .spyOn(github, 'retargetPrBase')
      .mockResolvedValue(undefined);

    const journal = await startCleanupJournal(dir);
    await appendCleanupOperation(dir, journal, {
      type: 'retarget',
      branch: 'feat/b',
      newBase: 'main',
    });

    const result = await resumeCleanup(dir);

    expect(result.applied).toHaveLength(0);
    expect(result.alreadyApplied).toHaveLength(1);
    expect(retarget).not.toHaveBeenCalled();
    getInfo.mockRestore();
    retarget.mockRestore();
  });

  it('skips the gh preflight when the journal has no retarget ops', async () => {
    writeState({
      stacks: [
        {
          id: 'stack-1',
          branches: [{ name: 'main', parent: null, type: 'root' }],
        },
      ],
    });

    const journal = await startCleanupJournal(dir);
    await appendCleanupOperation(dir, journal, {
      type: 'delete',
      branch: 'middle',
      reason: 'merged-pr',
    });

    await resumeCleanup(dir);

    expect(ensureGh).not.toHaveBeenCalled();
    expect(checkGh).not.toHaveBeenCalled();
  });

  it('runs the gh preflight before retarget replay', async () => {
    writeState({
      stacks: [
        {
          id: 'stack-1',
          branches: [
            { name: 'main', parent: null, type: 'root' },
            { name: 'feat/b', parent: 'main', pr_number: 2, pr_link: null },
          ],
        },
      ],
    });
    vi.spyOn(github, 'getBranchPrSyncInfo').mockResolvedValue({
      state: 'OPEN',
      baseRefName: 'main',
    });

    const journal = await startCleanupJournal(dir);
    await appendCleanupOperation(dir, journal, {
      type: 'retarget',
      branch: 'feat/b',
      newBase: 'main',
    });

    await resumeCleanup(dir);

    expect(ensureGh).toHaveBeenCalled();
    expect(checkGh).toHaveBeenCalled();
  });

  it('skips a retarget op when the PR is not OPEN (closed, merged, or absent)', async () => {
    writeState({ stacks: [{ id: 'stack-1', branches: [] }] });
    const getInfo = vi
      .spyOn(github, 'getBranchPrSyncInfo')
      .mockResolvedValue({ state: 'CLOSED', baseRefName: 'feat/a' });
    const retarget = vi
      .spyOn(github, 'retargetPrBase')
      .mockResolvedValue(undefined);

    const journal = await startCleanupJournal(dir);
    await appendCleanupOperation(dir, journal, {
      type: 'retarget',
      branch: 'feat/b',
      newBase: 'main',
    });

    const result = await resumeCleanup(dir);

    expect(result.applied).toHaveLength(0);
    expect(result.alreadyApplied).toHaveLength(1);
    expect(retarget).not.toHaveBeenCalled();
    getInfo.mockRestore();
    retarget.mockRestore();
  });

  it('split-track-branch: adds new branch to state when git has it but state does not', async () => {
    // Simulate a crashed split: new branch exists in git but state still only
    // knows about main + the source branch.
    await gitInRepo(dir, ['checkout', '-b', 'feat/source']);
    await commitFile('a.ts', 'a\n', 'feat: a');
    await gitInRepo(dir, ['checkout', '-b', 'feat/new', 'main']);
    await gitInRepo(dir, ['checkout', 'main']);

    writeState({
      stacks: [
        {
          id: 'stack-1',
          branches: [
            { name: 'main', parent: null, type: 'root' },
            {
              name: 'feat/source',
              parent: 'main',
              pr_number: null,
              pr_link: null,
            },
          ],
        },
      ],
    });

    const journal = await startCleanupJournal(dir);
    await appendCleanupOperation(dir, journal, {
      type: 'split-track-branch',
      branch: 'feat/new',
      parent: 'main',
      parentTip: 'main-tip-sha',
      sourceBranch: 'feat/source',
    });

    const result = await resumeCleanup(dir);

    expect(result.applied).toHaveLength(1);
    expect(result.applied[0].type).toBe('split-track-branch');
    const stacks = readState().stacks;
    const branchNames = stacks
      .flatMap((s) => s.branches.map((b) => b.name))
      .sort();
    expect(branchNames).toContain('feat/new');
  });

  it('split-track-branch: no-op when extractor rolled back (branch no longer exists in git)', async () => {
    writeState({
      stacks: [
        {
          id: 'stack-1',
          branches: [
            { name: 'main', parent: null, type: 'root' },
            {
              name: 'feat/source',
              parent: 'main',
              pr_number: null,
              pr_link: null,
            },
          ],
        },
      ],
    });

    const journal = await startCleanupJournal(dir);
    await appendCleanupOperation(dir, journal, {
      type: 'split-track-branch',
      branch: 'feat/never-created',
      parent: 'main',
      parentTip: 'sha-doesnt-matter',
      sourceBranch: 'feat/source',
    });

    const result = await resumeCleanup(dir);

    expect(result.applied).toHaveLength(0);
    expect(result.alreadyApplied).toHaveLength(1);
    // State should be untouched: no phantom branch entry added.
    const branchNames = readState()
      .stacks.flatMap((s) => s.branches.map((b) => b.name))
      .sort();
    expect(branchNames).not.toContain('feat/never-created');
  });

  it('split-track-branch: no-op when branch already in state', async () => {
    await gitInRepo(dir, ['checkout', '-b', 'feat/already-tracked']);
    await gitInRepo(dir, ['checkout', 'main']);

    writeState({
      stacks: [
        {
          id: 'stack-1',
          branches: [
            { name: 'main', parent: null, type: 'root' },
            {
              name: 'feat/already-tracked',
              parent: 'main',
              pr_number: null,
              pr_link: null,
            },
          ],
        },
      ],
    });

    const journal = await startCleanupJournal(dir);
    await appendCleanupOperation(dir, journal, {
      type: 'split-track-branch',
      branch: 'feat/already-tracked',
      parent: 'main',
      parentTip: 'sha-doesnt-matter',
      sourceBranch: 'feat/source',
    });

    const result = await resumeCleanup(dir);

    expect(result.applied).toHaveLength(0);
    expect(result.alreadyApplied).toHaveLength(1);
  });

  it('split-clear-source-pr: nulls pr_number when set, no-op when already null', async () => {
    writeState({
      stacks: [
        {
          id: 'stack-1',
          branches: [
            { name: 'main', parent: null, type: 'root' },
            {
              name: 'feat/with-pr',
              parent: 'main',
              pr_number: 42,
              pr_link: 'https://github.com/x/y/pull/42',
            },
            {
              name: 'feat/no-pr',
              parent: 'main',
              pr_number: null,
              pr_link: null,
            },
          ],
        },
      ],
    });

    const journal = await startCleanupJournal(dir);
    await appendCleanupOperation(dir, journal, {
      type: 'split-clear-source-pr',
      branch: 'feat/with-pr',
    });
    await appendCleanupOperation(dir, journal, {
      type: 'split-clear-source-pr',
      branch: 'feat/no-pr',
    });

    const result = await resumeCleanup(dir);

    expect(result.applied).toHaveLength(1);
    expect(result.alreadyApplied).toHaveLength(1);
    const branches = readState().stacks[0].branches as unknown as Array<{
      name: string;
      pr_number: number | null;
      pr_link: string | null;
    }>;
    const withPr = branches.find((b) => b.name === 'feat/with-pr');
    expect(withPr?.pr_number).toBeNull();
    expect(withPr?.pr_link).toBeNull();
  });

  it('split-track-branch: subsequent ops in the same journal see the newly-tracked branch', async () => {
    // Two sibling splits land in git; both track-branch ops journal; replay
    // must add both, and the second op must not see a stale snapshot of
    // state that excludes the first.
    await gitInRepo(dir, ['checkout', '-b', 'feat/source']);
    await commitFile('a.ts', 'a\n', 'feat: a');
    await gitInRepo(dir, ['checkout', '-b', 'feat/first', 'main']);
    await gitInRepo(dir, ['checkout', '-b', 'feat/second', 'main']);
    await gitInRepo(dir, ['checkout', 'main']);

    writeState({
      stacks: [
        {
          id: 'stack-1',
          branches: [
            { name: 'main', parent: null, type: 'root' },
            {
              name: 'feat/source',
              parent: 'main',
              pr_number: null,
              pr_link: null,
            },
          ],
        },
      ],
    });

    const journal = await startCleanupJournal(dir);
    for (const branch of ['feat/first', 'feat/second']) {
      await appendCleanupOperation(dir, journal, {
        type: 'split-track-branch',
        branch,
        parent: 'main',
        parentTip: 'main-tip',
        sourceBranch: 'feat/source',
      });
    }

    const result = await resumeCleanup(dir);

    expect(result.applied).toHaveLength(2);
    const branchNames = readState()
      .stacks.flatMap((s) => s.branches.map((b) => b.name))
      .sort();
    expect(branchNames).toContain('feat/first');
    expect(branchNames).toContain('feat/second');
  });
});
