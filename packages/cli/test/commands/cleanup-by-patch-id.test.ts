import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isMergedByPatchId } from '../../src/lib/git/is-merged-by-patch-id';
import { buildCleanupPlan } from '../../src/lib/sync/cleanup';
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

async function commitFile(name: string, body: string, message: string) {
  fs.writeFileSync(path.join(dir, name), body);
  await gitInRepo(dir, ['add', name]);
  await gitInRepo(dir, ['commit', '-m', message]);
}

describe('cleanup integration with patch-id detection', () => {
  it('plans deletion for a branch that was squash-merged into trunk (no PR metadata)', async () => {
    // Create feature branch with two commits.
    await gitInRepo(dir, ['checkout', '-b', 'feat/squashed']);
    await commitFile('feat-a.txt', 'a\n', 'feat: add a');
    await commitFile('feat-b.txt', 'b\n', 'feat: add b');

    // Simulate `gh pr merge --squash`: one commit on trunk that contains
    // both files. Branch metadata (PR state) is unavailable.
    await gitInRepo(dir, ['checkout', 'main']);
    fs.writeFileSync(path.join(dir, 'feat-a.txt'), 'a\n');
    fs.writeFileSync(path.join(dir, 'feat-b.txt'), 'b\n');
    await gitInRepo(dir, ['add', 'feat-a.txt', 'feat-b.txt']);
    await gitInRepo(dir, ['commit', '-m', 'squash: feat']);

    const plan = await buildCleanupPlan({
      branches: ['feat/squashed'],
      getPrStatus: vi.fn().mockResolvedValue('NONE'),
      isMergedIntoAnyRoot: vi.fn().mockResolvedValue(false),
      isMergedByPatchId: (branch) => isMergedByPatchId(branch, 'main', dir),
    });

    expect(plan.toDelete).toEqual([
      { branch: 'feat/squashed', reason: 'merged-by-patch-id' },
    ]);
    expect(plan.skipped).toEqual([]);
  });

  it('leaves a branch alone when it has unique commits not in trunk', async () => {
    await gitInRepo(dir, ['checkout', '-b', 'feat/wip']);
    await commitFile('wip.txt', 'wip\n', 'feat: wip');

    await gitInRepo(dir, ['checkout', 'main']);
    await commitFile('trunk.txt', 'trunk\n', 'chore: trunk');

    const plan = await buildCleanupPlan({
      branches: ['feat/wip'],
      getPrStatus: vi.fn().mockResolvedValue('NONE'),
      isMergedIntoAnyRoot: vi.fn().mockResolvedValue(false),
      isMergedByPatchId: (branch) => isMergedByPatchId(branch, 'main', dir),
    });

    expect(plan.toDelete).toEqual([]);
    expect(plan.skipped).toEqual([]);
  });
});
