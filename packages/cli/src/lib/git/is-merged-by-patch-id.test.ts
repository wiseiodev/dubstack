import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestRepo, gitInRepo } from '../../../test/helpers';
import { isMergedByPatchId } from './is-merged-by-patch-id';

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

async function commitFile(name: string, body: string, message: string) {
  fs.writeFileSync(path.join(dir, name), body);
  await gitInRepo(dir, ['add', name]);
  await gitInRepo(dir, ['commit', '-m', message]);
}

describe('isMergedByPatchId', () => {
  it('returns true for a squash-merged branch', async () => {
    // Branch with two commits whose combined tree matches a single trunk commit.
    await gitInRepo(dir, ['checkout', '-b', 'feat']);
    await commitFile('a.txt', 'a\n', 'add a');
    await commitFile('b.txt', 'b\n', 'add b');

    await gitInRepo(dir, ['checkout', 'main']);
    // Squash equivalent: one commit that applies both files at once.
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
    await gitInRepo(dir, ['add', 'a.txt', 'b.txt']);
    await gitInRepo(dir, ['commit', '-m', 'squash: a + b']);

    expect(await isMergedByPatchId('feat', 'main', dir)).toBe(true);
  });

  it('returns true for a rebase-merged branch', async () => {
    await gitInRepo(dir, ['checkout', '-b', 'feat']);
    await commitFile('a.txt', 'a\n', 'add a');
    await commitFile('b.txt', 'b\n', 'add b');

    await gitInRepo(dir, ['checkout', 'main']);
    // Rebase-merge: trunk replays the same two commits, individually.
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    await gitInRepo(dir, ['add', 'a.txt']);
    await gitInRepo(dir, ['commit', '-m', 'add a']);
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
    await gitInRepo(dir, ['add', 'b.txt']);
    await gitInRepo(dir, ['commit', '-m', 'add b']);

    expect(await isMergedByPatchId('feat', 'main', dir)).toBe(true);
  });

  it('returns false for a branch with unique commits not in trunk', async () => {
    await gitInRepo(dir, ['checkout', '-b', 'feat']);
    await commitFile('feat.txt', 'feat\n', 'add feat');

    await gitInRepo(dir, ['checkout', 'main']);
    await commitFile('main.txt', 'main\n', 'add main');

    expect(await isMergedByPatchId('feat', 'main', dir)).toBe(false);
  });

  it('returns false when only some commits are in trunk and the tip is not', async () => {
    await gitInRepo(dir, ['checkout', '-b', 'feat']);
    await commitFile('a.txt', 'a\n', 'add a');
    await commitFile('b.txt', 'b\n', 'add b');
    await commitFile('c.txt', 'c\n', 'add c (unique)');

    await gitInRepo(dir, ['checkout', 'main']);
    // Trunk replays a + b but not c, so the branch tip is not in trunk.
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    await gitInRepo(dir, ['add', 'a.txt']);
    await gitInRepo(dir, ['commit', '-m', 'add a']);
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
    await gitInRepo(dir, ['add', 'b.txt']);
    await gitInRepo(dir, ['commit', '-m', 'add b']);

    expect(await isMergedByPatchId('feat', 'main', dir)).toBe(false);
  });

  it('returns false with a logged warning when branch exceeds the commit cap', async () => {
    await gitInRepo(dir, ['checkout', '-b', 'huge']);
    for (let i = 0; i < 5; i++) {
      await commitFile(`f-${i}.txt`, `${i}\n`, `commit ${i}`);
    }

    const warn = vi.fn();
    const result = await isMergedByPatchId('huge', 'main', dir, {
      maxCommits: 3,
      warn,
    });

    expect(result).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/5 commits.*> 3 cap/);
  });
});
