import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { create } from '../../src/commands/create';
import { init } from '../../src/commands/init';
import { move } from '../../src/commands/move';
import { undo } from '../../src/commands/undo';
import { hasCleanupJournal } from '../../src/lib/cleanup-journal';
import { getBranchTip } from '../../src/lib/git';
import { findStackForBranch, readState } from '../../src/lib/state';
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
  return findStackForBranch(state, name)?.branches.find((b) => b.name === name);
}

describe('move command', () => {
  it('--before inserts the branch between target and its old parent', async () => {
    // main → feat/auth-base → feat/auth-login; feat/inserted off main
    await create('feat/auth-base', dir);
    await commitFile('base.txt', 'base', 'base-commit');

    await create('feat/auth-login', dir);
    await commitFile('login.txt', 'login', 'login-commit');

    await gitInRepo(dir, ['checkout', 'main']);
    await create('feat/inserted', dir);
    await commitFile('inserted.txt', 'inserted', 'inserted-commit');

    // Pre-condition: feat/inserted.parent === main, feat/auth-login.parent === auth-base
    let state = await readState(dir);
    expect(getBranch(state, 'feat/auth-login')?.parent).toBe('feat/auth-base');
    expect(getBranch(state, 'feat/inserted')?.parent).toBe('main');

    const result = await move(dir, 'feat/inserted', {
      before: 'feat/auth-login',
    });

    expect(result.noOp).toBe(false);
    expect(result.position).toBe('before');
    expect(result.newParent).toBe('feat/auth-base');
    expect(result.reparented.sort()).toEqual(
      ['feat/auth-login', 'feat/inserted'].sort(),
    );

    state = await readState(dir);
    // After: main → auth-base → inserted → auth-login
    expect(getBranch(state, 'feat/inserted')?.parent).toBe('feat/auth-base');
    expect(getBranch(state, 'feat/auth-login')?.parent).toBe('feat/inserted');

    // auth-login must have been rebased onto inserted: its log contains the
    // inserted-commit.
    const log = (
      await gitInRepo(dir, ['log', '--oneline', 'feat/auth-login'])
    ).stdout.trim();
    expect(log).toContain('inserted-commit');
    expect(log).toContain('login-commit');
    expect(log).toContain('base-commit');

    // Cleanup journal cleared on success.
    expect(await hasCleanupJournal(dir)).toBe(false);
  });

  it('--after inserts the branch as a child of target and adopts targets old children', async () => {
    // main → feat/auth-base → feat/auth-login
    await create('feat/auth-base', dir);
    await commitFile('base.txt', 'base', 'base-commit');

    await create('feat/auth-login', dir);
    await commitFile('login.txt', 'login', 'login-commit');

    // feat/inserted: separate branch built off main
    await gitInRepo(dir, ['checkout', 'main']);
    await create('feat/inserted', dir);
    await commitFile('inserted.txt', 'inserted', 'inserted-commit');

    const result = await move(dir, 'feat/inserted', {
      after: 'feat/auth-base',
    });

    expect(result.noOp).toBe(false);
    expect(result.position).toBe('after');
    expect(result.newParent).toBe('feat/auth-base');
    expect(result.reparented.sort()).toEqual(
      ['feat/auth-login', 'feat/inserted'].sort(),
    );

    const state = await readState(dir);
    // After: main → auth-base → inserted → auth-login (insert-between)
    expect(getBranch(state, 'feat/inserted')?.parent).toBe('feat/auth-base');
    expect(getBranch(state, 'feat/auth-login')?.parent).toBe('feat/inserted');

    // auth-login should have been rebased onto inserted
    const log = (
      await gitInRepo(dir, ['log', '--oneline', 'feat/auth-login'])
    ).stdout.trim();
    expect(log).toContain('inserted-commit');
    expect(log).toContain('login-commit');
  });

  it('--after absorbs every sibling under the target into the moved branch', async () => {
    // main → feat/base → {feat/a, feat/b}; feat/inserted off main.
    // After dub move feat/inserted --after feat/base:
    // main → feat/base → feat/inserted → {feat/a, feat/b}
    await create('feat/base', dir);
    await commitFile('base.txt', 'base', 'base-commit');

    await create('feat/a', dir);
    await commitFile('a.txt', 'a', 'a-commit');

    await gitInRepo(dir, ['checkout', 'feat/base']);
    await create('feat/b', dir);
    await commitFile('b.txt', 'b', 'b-commit');

    await gitInRepo(dir, ['checkout', 'main']);
    await create('feat/inserted', dir);
    await commitFile('inserted.txt', 'inserted', 'inserted-commit');

    const result = await move(dir, 'feat/inserted', {
      after: 'feat/base',
    });

    expect(result.noOp).toBe(false);
    // All three branches whose parent changed should be in `reparented`.
    expect(result.reparented.sort()).toEqual(
      ['feat/a', 'feat/b', 'feat/inserted'].sort(),
    );

    const state = await readState(dir);
    expect(getBranch(state, 'feat/inserted')?.parent).toBe('feat/base');
    expect(getBranch(state, 'feat/a')?.parent).toBe('feat/inserted');
    expect(getBranch(state, 'feat/b')?.parent).toBe('feat/inserted');

    // Both siblings should have been rebased onto feat/inserted.
    for (const name of ['feat/a', 'feat/b']) {
      const log = (
        await gitInRepo(dir, ['log', '--oneline', name])
      ).stdout.trim();
      expect(log).toContain('inserted-commit');
      expect(log).toContain('base-commit');
    }
  });

  it('rejects a move that would create a cycle', async () => {
    // main → feat/a → feat/b
    await create('feat/a', dir);
    await commitFile('a.txt', 'a', 'a-commit');
    await create('feat/b', dir);
    await commitFile('b.txt', 'b', 'b-commit');

    // Try to make feat/a a child of feat/b (its own descendant) → cycle
    await expect(move(dir, 'feat/a', { after: 'feat/b' })).rejects.toThrowError(
      /cycle/i,
    );

    // No mutation should have happened
    const state = await readState(dir);
    expect(getBranch(state, 'feat/a')?.parent).toBe('main');
    expect(getBranch(state, 'feat/b')?.parent).toBe('feat/a');
    expect(await hasCleanupJournal(dir)).toBe(false);
  });

  it('returns a no-op when --before target is already a child of branch', async () => {
    // main → feat/a → feat/b: feat/a is already feat/b's parent
    await create('feat/a', dir);
    await commitFile('a.txt', 'a', 'a-commit');
    await create('feat/b', dir);
    await commitFile('b.txt', 'b', 'b-commit');

    const result = await move(dir, 'feat/a', { before: 'feat/b' });
    expect(result.noOp).toBe(true);
    expect(result.noOpReason).toMatch(/already a child/);
    expect(result.reparented).toEqual([]);

    // State unchanged.
    const state = await readState(dir);
    expect(getBranch(state, 'feat/a')?.parent).toBe('main');
    expect(getBranch(state, 'feat/b')?.parent).toBe('feat/a');
  });

  it('returns a no-op when --after branch is already targets sole child', async () => {
    // main → feat/a → feat/b: feat/b's parent is already feat/a, and a has no other children
    await create('feat/a', dir);
    await commitFile('a.txt', 'a', 'a-commit');
    await create('feat/b', dir);
    await commitFile('b.txt', 'b', 'b-commit');

    const result = await move(dir, 'feat/b', { after: 'feat/a' });
    expect(result.noOp).toBe(true);
    expect(result.reparented).toEqual([]);
  });

  it('requires exactly one of --before or --after', async () => {
    await create('feat/a', dir);
    await commitFile('a.txt', 'a', 'a-commit');

    await expect(move(dir, 'feat/a', {})).rejects.toThrowError(
      /Specify exactly one/,
    );
    await expect(
      move(dir, 'feat/a', { before: 'main', after: 'main' }),
    ).rejects.toThrowError(/Specify exactly one/);
  });

  it('errors when either branch is untracked', async () => {
    await create('feat/a', dir);
    await commitFile('a.txt', 'a', 'a-commit');

    // Untracked git branch
    await gitInRepo(dir, ['checkout', '-b', 'feat/loose']);
    await commitFile('loose.txt', 'loose', 'loose-commit');

    await expect(
      move(dir, 'feat/loose', { after: 'feat/a' }),
    ).rejects.toThrowError(/'feat\/loose' is not tracked/);
  });

  it('dub undo restores the pre-move state and branch tips', async () => {
    // main → feat/auth-base → feat/auth-login; feat/inserted off main
    await create('feat/auth-base', dir);
    await commitFile('base.txt', 'base', 'base-commit');

    await create('feat/auth-login', dir);
    await commitFile('login.txt', 'login', 'login-commit');

    await gitInRepo(dir, ['checkout', 'main']);
    await create('feat/inserted', dir);
    await commitFile('inserted.txt', 'inserted', 'inserted-commit');

    const preLoginTip = await getBranchTip('feat/auth-login', dir);

    await move(dir, 'feat/inserted', { before: 'feat/auth-login' });

    // Sanity check that move ran
    let state = await readState(dir);
    expect(getBranch(state, 'feat/auth-login')?.parent).toBe('feat/inserted');

    const undoResult = await undo(dir);
    expect(undoResult.undone).toBe('move');

    state = await readState(dir);
    expect(getBranch(state, 'feat/auth-login')?.parent).toBe('feat/auth-base');
    expect(getBranch(state, 'feat/inserted')?.parent).toBe('main');

    // auth-login tip should match pre-move tip (rebase undone)
    expect(await getBranchTip('feat/auth-login', dir)).toBe(preLoginTip);
  });
});
