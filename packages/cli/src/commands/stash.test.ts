import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestRepo, gitInRepo } from '../../test/helpers';
import { getCurrentBranch } from '../lib/git';
import { readStashLog } from '../lib/stash-log';
import { init } from './init';
import { stashList, stashPop, stashPush } from './stash';

let dir: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  const repo = await createTestRepo();
  dir = repo.dir;
  cleanup = repo.cleanup;
  await init(dir);
  // Commit the .gitignore that `init` writes so the working tree is clean
  // baseline. Then add another committed file as a stable starting point.
  fs.writeFileSync(path.join(dir, 'baseline.txt'), 'baseline\n');
  await gitInRepo(dir, ['add', '-A']);
  await gitInRepo(dir, ['commit', '-m', 'baseline']);
});

afterEach(async () => {
  await cleanup();
});

/** Write a tracked file change so the working tree is dirty for stashing. */
function dirtyTrackedFile(name = 'wip.txt', body = 'work in progress\n'): void {
  fs.writeFileSync(path.join(dir, name), body);
}

describe('dub stash push', () => {
  it('captures changes, records the source branch, and clears the working tree', async () => {
    await gitInRepo(dir, ['checkout', '-b', 'feat/a']);
    dirtyTrackedFile();

    const result = await stashPush(dir);

    expect(result.branch).toBe('feat/a');
    expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.message).toContain('feat/a');

    // Working tree should be clean after the stash.
    const { stdout } = await gitInRepo(dir, ['status', '--porcelain']);
    expect(stdout.trim()).toBe('');

    const log = await readStashLog(dir);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      branch: 'feat/a',
      sha: result.sha,
      message: result.message,
    });
  });

  it('uses an explicit message when provided', async () => {
    await gitInRepo(dir, ['checkout', '-b', 'feat/msg']);
    dirtyTrackedFile();

    const result = await stashPush(dir, { message: 'wip: refactor' });
    expect(result.message).toBe('wip: refactor');
  });

  it('refuses when the working tree is clean', async () => {
    await gitInRepo(dir, ['checkout', '-b', 'feat/clean']);

    await expect(stashPush(dir)).rejects.toThrow(/Nothing to stash/);
    const log = await readStashLog(dir);
    expect(log).toEqual([]);
  });

  it('includes untracked files in the stash', async () => {
    await gitInRepo(dir, ['checkout', '-b', 'feat/untracked']);
    fs.writeFileSync(path.join(dir, 'new-file.txt'), 'fresh\n');

    await stashPush(dir);

    // Stash should remove the untracked file from the working tree.
    expect(fs.existsSync(path.join(dir, 'new-file.txt'))).toBe(false);
  });
});

describe('dub stash pop (same branch)', () => {
  it('pops on the same branch by default', async () => {
    await gitInRepo(dir, ['checkout', '-b', 'feat/a']);
    dirtyTrackedFile('wip.txt', 'aaa\n');
    const pushed = await stashPush(dir);

    const popped = await stashPop(dir);

    expect(popped.branch).toBe('feat/a');
    expect(popped.sourceBranch).toBe('feat/a');
    expect(popped.sha).toBe(pushed.sha);
    expect(popped.checkedOut).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'wip.txt'), 'utf-8')).toBe('aaa\n');

    const log = await readStashLog(dir);
    expect(log).toEqual([]);
  });
});

describe('dub stash pop (branch mismatch)', () => {
  it('refuses to pop on a different branch without --on or --force', async () => {
    await gitInRepo(dir, ['checkout', '-b', 'feat/a']);
    dirtyTrackedFile('wip.txt');
    await stashPush(dir);

    await gitInRepo(dir, ['checkout', '-b', 'feat/b']);

    await expect(stashPop(dir)).rejects.toThrow(
      /Stash was created on 'feat\/a' but you are on 'feat\/b'/,
    );
    const log = await readStashLog(dir);
    expect(log).toHaveLength(1);
  });

  it('--on <branch> checks out the target branch then pops', async () => {
    await gitInRepo(dir, ['checkout', '-b', 'feat/a']);
    dirtyTrackedFile('wip.txt', 'aaa\n');
    await stashPush(dir);

    await gitInRepo(dir, ['checkout', '-b', 'feat/b']);
    expect(await getCurrentBranch(dir)).toBe('feat/b');

    const result = await stashPop(dir, { on: 'feat/a' });
    expect(result.branch).toBe('feat/a');
    expect(result.checkedOut).toBe(true);
    expect(await getCurrentBranch(dir)).toBe('feat/a');
    expect(fs.readFileSync(path.join(dir, 'wip.txt'), 'utf-8')).toBe('aaa\n');
  });

  it('--force pops onto the current branch even when it differs', async () => {
    await gitInRepo(dir, ['checkout', '-b', 'feat/a']);
    dirtyTrackedFile('wip.txt', 'aaa\n');
    await stashPush(dir);

    await gitInRepo(dir, ['checkout', '-b', 'feat/b']);

    const result = await stashPop(dir, { force: true });
    expect(result.branch).toBe('feat/b');
    expect(result.sourceBranch).toBe('feat/a');
    expect(result.checkedOut).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'wip.txt'), 'utf-8')).toBe('aaa\n');
  });

  it('--on <branch> targeting the current branch skips the checkout', async () => {
    await gitInRepo(dir, ['checkout', '-b', 'feat/a']);
    dirtyTrackedFile('wip.txt', 'aaa\n');
    await stashPush(dir);

    // Stay on feat/a (the source branch) and pop with --on feat/a.
    expect(await getCurrentBranch(dir)).toBe('feat/a');
    const result = await stashPop(dir, { on: 'feat/a' });
    expect(result.branch).toBe('feat/a');
    expect(result.checkedOut).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'wip.txt'), 'utf-8')).toBe('aaa\n');
  });

  it('--on wins when both --on and --force are passed', async () => {
    await gitInRepo(dir, ['checkout', '-b', 'feat/a']);
    dirtyTrackedFile('wip.txt', 'aaa\n');
    await stashPush(dir);

    await gitInRepo(dir, ['checkout', '-b', 'feat/b']);

    // --on feat/a should checkout feat/a and pop there; --force is ignored.
    const result = await stashPop(dir, { on: 'feat/a', force: true });
    expect(result.branch).toBe('feat/a');
    expect(result.sourceBranch).toBe('feat/a');
    expect(result.checkedOut).toBe(true);
    expect(await getCurrentBranch(dir)).toBe('feat/a');
  });

  it('--on errors when the target branch does not exist', async () => {
    await gitInRepo(dir, ['checkout', '-b', 'feat/a']);
    dirtyTrackedFile('wip.txt');
    await stashPush(dir);

    await expect(stashPop(dir, { on: 'feat/missing' })).rejects.toThrow(
      "Branch 'feat/missing' does not exist.",
    );
  });
});

describe('dub stash pop (empty / dangling)', () => {
  it('errors with a recovery hint when the log is empty', async () => {
    await expect(stashPop(dir)).rejects.toThrow(/No dub stash entries to pop/);
  });

  it('removes the dangling log entry when the stash was dropped externally', async () => {
    await gitInRepo(dir, ['checkout', '-b', 'feat/a']);
    dirtyTrackedFile('wip.txt');
    await stashPush(dir);

    // Drop the stash outside DubStack — the log entry is now dangling.
    await gitInRepo(dir, ['stash', 'drop', 'stash@{0}']);

    await expect(stashPop(dir)).rejects.toThrow(
      /no longer in 'git stash list'/,
    );
    const log = await readStashLog(dir);
    expect(log).toEqual([]);
  });
});

describe('dub stash list', () => {
  it('returns an empty result when nothing is recorded', async () => {
    const result = await stashList(dir);
    expect(result.entries).toEqual([]);
  });

  it('shows recorded stashes with branch context and presence', async () => {
    await gitInRepo(dir, ['checkout', '-b', 'feat/a']);
    dirtyTrackedFile('a.txt');
    await stashPush(dir);

    await gitInRepo(dir, ['checkout', 'main']);
    await gitInRepo(dir, ['checkout', '-b', 'feat/b']);
    dirtyTrackedFile('b.txt');
    await stashPush(dir);

    const result = await stashList(dir);
    expect(result.entries).toHaveLength(2);
    // Most-recent first.
    expect(result.entries[0].branch).toBe('feat/b');
    expect(result.entries[1].branch).toBe('feat/a');
    for (const entry of result.entries) {
      expect(entry.present).toBe(true);
      expect(entry.ref).toMatch(/^stash@\{\d\}$/);
    }
  });

  it('marks dangling entries as not present', async () => {
    await gitInRepo(dir, ['checkout', '-b', 'feat/a']);
    dirtyTrackedFile('wip.txt');
    await stashPush(dir);

    await gitInRepo(dir, ['stash', 'drop', 'stash@{0}']);

    const result = await stashList(dir);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].present).toBe(false);
    expect(result.entries[0].ref).toBeNull();
  });
});
