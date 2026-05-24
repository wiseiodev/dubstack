import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from '../../src/commands/create';
import { init } from '../../src/commands/init';
import { restack, restackContinue } from '../../src/commands/restack';
import { getBranchTip } from '../../src/lib/git';
import { readState } from '../../src/lib/state';
import { createTestRepo, gitInRepo } from '../helpers';

let dir: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  const repo = await createTestRepo();
  dir = repo.dir;
  cleanup = repo.cleanup;
  await init(dir);
  await gitInRepo(dir, ['add', '.']);
  await gitInRepo(dir, ['commit', '-m', 'init dubstack']);
});

afterEach(async () => {
  await cleanup();
});

async function commitFile(
  filename: string,
  contents: string,
  message: string,
): Promise<void> {
  fs.writeFileSync(path.join(dir, filename), contents);
  await gitInRepo(dir, ['add', '.']);
  await gitInRepo(dir, ['commit', '-m', message]);
}

function getBranch(state: Awaited<ReturnType<typeof readState>>, name: string) {
  for (const stack of state.stacks) {
    const branch = stack.branches.find((b) => b.name === name);
    if (branch) return branch;
  }
  return undefined;
}

describe('restack on tree-shaped stacks', () => {
  it('scenario 1: trunk → base → {a,b,c}; trunk advances, base + all siblings cascade onto new parents', async () => {
    // main → feat/base → {feat/a, feat/b, feat/c}
    await create('feat/base', dir);
    await commitFile('base.txt', 'base', 'base-commit');

    await create('feat/a', dir);
    await commitFile('a.txt', 'a', 'a-commit');

    await gitInRepo(dir, ['checkout', 'feat/base']);
    await create('feat/b', dir);
    await commitFile('b.txt', 'b', 'b-commit');

    await gitInRepo(dir, ['checkout', 'feat/base']);
    await create('feat/c', dir);
    await commitFile('c.txt', 'c', 'c-commit');

    // Trunk advances
    await gitInRepo(dir, ['checkout', 'main']);
    await commitFile('main.txt', 'main', 'main-commit');
    const newMainTip = await getBranchTip('main', dir);

    // Restack from a sibling — should cover the whole stack in topo order
    await gitInRepo(dir, ['checkout', 'feat/b']);
    const result = await restack(dir);

    expect(result.status).toBe('success');
    // Topo order: base, then alphabetical siblings
    expect(result.rebased).toEqual(['feat/base', 'feat/a', 'feat/b', 'feat/c']);

    // Verify parent_revision cascade
    const state = await readState(dir);
    const newBaseTip = await getBranchTip('feat/base', dir);

    expect(getBranch(state, 'feat/base')?.parent_revision).toBe(newMainTip);
    expect(getBranch(state, 'feat/a')?.parent_revision).toBe(newBaseTip);
    expect(getBranch(state, 'feat/b')?.parent_revision).toBe(newBaseTip);
    expect(getBranch(state, 'feat/c')?.parent_revision).toBe(newBaseTip);

    // No duplicate commits: each sibling should contain main + base + its own
    for (const branch of ['feat/a', 'feat/b', 'feat/c']) {
      const log = (
        await gitInRepo(dir, ['log', '--oneline', branch])
      ).stdout.trim();
      const lines = log.split('\n');
      const messages = lines.map((l) => l.split(' ').slice(1).join(' '));
      // init, main-commit, base-commit, <branch>-commit
      expect(messages.filter((m) => m === 'base-commit')).toHaveLength(1);
      expect(messages.filter((m) => m === 'main-commit')).toHaveLength(1);
    }
  });

  it('scenario 2: restacking from a non-root sibling rebuilds the full tree containing it', async () => {
    // main → {feat/a → feat/a1, feat/b, feat/c}
    await create('feat/a', dir);
    await commitFile('a.txt', 'a', 'a-commit');

    await create('feat/a1', dir);
    await commitFile('a1.txt', 'a1', 'a1-commit');

    await gitInRepo(dir, ['checkout', 'main']);
    await create('feat/b', dir);
    await commitFile('b.txt', 'b', 'b-commit');

    await gitInRepo(dir, ['checkout', 'main']);
    await create('feat/c', dir);
    await commitFile('c.txt', 'c', 'c-commit');

    // main advances
    await gitInRepo(dir, ['checkout', 'main']);
    await commitFile('main.txt', 'main', 'main-commit');
    const newMainTip = await getBranchTip('main', dir);

    // Restack invoked from feat/b (non-root). getTargetStacks returns the
    // single stack containing b — which is the whole tree.
    await gitInRepo(dir, ['checkout', 'feat/b']);
    const result = await restack(dir);

    expect(result.status).toBe('success');
    // All non-root descendants must be rebased, in BFS order.
    expect(result.rebased).toEqual(['feat/a', 'feat/b', 'feat/c', 'feat/a1']);

    const state = await readState(dir);
    const newATip = await getBranchTip('feat/a', dir);
    expect(getBranch(state, 'feat/a')?.parent_revision).toBe(newMainTip);
    expect(getBranch(state, 'feat/b')?.parent_revision).toBe(newMainTip);
    expect(getBranch(state, 'feat/c')?.parent_revision).toBe(newMainTip);
    expect(getBranch(state, 'feat/a1')?.parent_revision).toBe(newATip);
  });

  it('scenario 3: one sibling conflicts; other siblings preserved; continue resumes remaining', async () => {
    // main → {feat/a, feat/b, feat/c}; b will conflict with main on conflict.txt
    await create('feat/a', dir);
    await commitFile('a.txt', 'a', 'a-commit');

    await gitInRepo(dir, ['checkout', 'main']);
    await create('feat/b', dir);
    await commitFile('conflict.txt', 'from-b', 'b-conflict-commit');

    await gitInRepo(dir, ['checkout', 'main']);
    await create('feat/c', dir);
    await commitFile('c.txt', 'c', 'c-commit');

    // Make main change the same file that feat/b touched, forcing a conflict
    await gitInRepo(dir, ['checkout', 'main']);
    await commitFile('conflict.txt', 'from-main', 'main-conflict-commit');
    const newMainTip = await getBranchTip('main', dir);

    await gitInRepo(dir, ['checkout', 'feat/a']);
    const first = await restack(dir);

    expect(first.status).toBe('conflict');
    expect(first.conflictBranch).toBe('feat/b');
    // feat/a (alphabetically first) was already rebased before the conflict
    expect(first.rebased).toEqual(['feat/a']);

    // Resolve the conflict by accepting main's version
    fs.writeFileSync(path.join(dir, 'conflict.txt'), 'from-main');
    await gitInRepo(dir, ['add', 'conflict.txt']);

    const second = await restackContinue(dir);

    expect(second.status).toBe('success');
    // executeRestackSteps re-walks all steps; previously-done a is replayed
    // in the rebased list, then b (resumed) then c.
    expect(second.rebased).toEqual(['feat/a', 'feat/b', 'feat/c']);

    // Final state: all siblings point at the new main tip.
    const state = await readState(dir);
    expect(getBranch(state, 'feat/a')?.parent_revision).toBe(newMainTip);
    expect(getBranch(state, 'feat/b')?.parent_revision).toBe(newMainTip);
    expect(getBranch(state, 'feat/c')?.parent_revision).toBe(newMainTip);
  });

  it('scenario 4: sibling already merged (patch-equivalent) is skipped; other siblings still restack', async () => {
    // main → {feat/a, feat/b}
    await create('feat/a', dir);
    await commitFile('file-a.txt', 'feature a', 'add file-a');

    await gitInRepo(dir, ['checkout', 'main']);
    await create('feat/b', dir);
    await commitFile('file-b.txt', 'feature b', 'add file-b');

    // Squash-merge feat/a into main: its patch is now in main.
    await gitInRepo(dir, ['checkout', 'main']);
    await gitInRepo(dir, ['merge', '--squash', 'feat/a']);
    await gitInRepo(dir, ['commit', '-m', 'squash A']);
    const newMainTip = await getBranchTip('main', dir);

    const result = await restack(dir);

    expect(result.status).toBe('success');
    // feat/a is skipped (patch-equivalent), feat/b restacks onto new main
    expect(result.rebased).toEqual(['feat/b']);

    const state = await readState(dir);
    expect(getBranch(state, 'feat/b')?.parent_revision).toBe(newMainTip);

    // feat/b should still have both files (file-a from squash on main, its own file-b)
    await gitInRepo(dir, ['checkout', 'feat/b']);
    expect(fs.existsSync(path.join(dir, 'file-a.txt'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'file-b.txt'))).toBe(true);

    // No duplicate of file-b in feat/b on top of main
    const log = (
      await gitInRepo(dir, ['log', '--oneline', 'main..feat/b'])
    ).stdout.trim();
    const lines = log.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('add file-b');
  });

  it('scenario 5: sibling checked out in another worktree is skipped with log; remaining siblings restack', async () => {
    // main → {feat/a, feat/b, feat/c}
    await create('feat/a', dir);
    await commitFile('a.txt', 'a', 'a-commit');

    await gitInRepo(dir, ['checkout', 'main']);
    await create('feat/b', dir);
    await commitFile('b.txt', 'b', 'b-commit');
    const bTipBefore = await getBranchTip('feat/b', dir);

    await gitInRepo(dir, ['checkout', 'main']);
    await create('feat/c', dir);
    await commitFile('c.txt', 'c', 'c-commit');

    await gitInRepo(dir, ['checkout', 'main']);
    await commitFile('main.txt', 'main', 'main-commit');
    const newMainTip = await getBranchTip('main', dir);

    const worktreeDir = `${dir}-feat-b-worktree`;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await gitInRepo(dir, ['worktree', 'add', worktreeDir, 'feat/b']);

      const result = await restack(dir);

      expect(result.status).toBe('success');
      expect(result.rebased).toEqual(['feat/a', 'feat/c']);

      // Skip log line for the worktree-held sibling
      const messages = logSpy.mock.calls.map((args) => args.join(' '));
      const skipMessages = messages.filter((m) =>
        m.includes("Skipped 'feat/b'"),
      );
      expect(skipMessages).toHaveLength(1);
      expect(skipMessages[0]).toContain(worktreeDir);

      // feat/b's git tip is untouched
      expect(await getBranchTip('feat/b', dir)).toBe(bTipBefore);

      const state = await readState(dir);
      expect(getBranch(state, 'feat/a')?.parent_revision).toBe(newMainTip);
      expect(getBranch(state, 'feat/c')?.parent_revision).toBe(newMainTip);
    } finally {
      logSpy.mockRestore();
      await gitInRepo(dir, [
        'worktree',
        'remove',
        '--force',
        worktreeDir,
      ]).catch(() => {});
      await fs.promises.rm(worktreeDir, { recursive: true, force: true });
    }
  });

  it('scenario 6: restack invoked from the trunk covers all descendants in topo order', async () => {
    // main → {feat/a, feat/b, feat/c}
    await create('feat/a', dir);
    await commitFile('a.txt', 'a', 'a-commit');

    await gitInRepo(dir, ['checkout', 'main']);
    await create('feat/b', dir);
    await commitFile('b.txt', 'b', 'b-commit');

    await gitInRepo(dir, ['checkout', 'main']);
    await create('feat/c', dir);
    await commitFile('c.txt', 'c', 'c-commit');

    await gitInRepo(dir, ['checkout', 'main']);
    await commitFile('main.txt', 'main', 'main-commit');
    const newMainTip = await getBranchTip('main', dir);

    // Invoke restack while on the root (main).
    const result = await restack(dir);

    expect(result.status).toBe('success');
    expect(result.rebased).toEqual(['feat/a', 'feat/b', 'feat/c']);

    const state = await readState(dir);
    expect(getBranch(state, 'feat/a')?.parent_revision).toBe(newMainTip);
    expect(getBranch(state, 'feat/b')?.parent_revision).toBe(newMainTip);
    expect(getBranch(state, 'feat/c')?.parent_revision).toBe(newMainTip);
  });
});
