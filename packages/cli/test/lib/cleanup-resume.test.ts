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

beforeEach(async () => {
  const repo = await createTestRepo();
  dir = repo.dir;
  cleanup = repo.cleanup;
});

afterEach(async () => {
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
      oldBase: 'feat/a',
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
      oldBase: 'feat/a',
      newBase: 'main',
    });

    const result = await resumeCleanup(dir);

    expect(result.applied).toHaveLength(0);
    expect(result.alreadyApplied).toHaveLength(1);
    expect(retarget).not.toHaveBeenCalled();
    getInfo.mockRestore();
    retarget.mockRestore();
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
      oldBase: 'feat/a',
      newBase: 'main',
    });

    const result = await resumeCleanup(dir);

    expect(result.applied).toHaveLength(0);
    expect(result.alreadyApplied).toHaveLength(1);
    expect(retarget).not.toHaveBeenCalled();
    getInfo.mockRestore();
    retarget.mockRestore();
  });
});
