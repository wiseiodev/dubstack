import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { create } from '../../src/commands/create';
import { init } from '../../src/commands/init';
import { reorder } from '../../src/commands/reorder';
import { undo } from '../../src/commands/undo';
import { getBranchTip } from '../../src/lib/git';
import type { RebaseTodoEntry } from '../../src/lib/rebase-todo';
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

async function getCommitSubjects(ref: string): Promise<string[]> {
  const { stdout } = await gitInRepo(dir, [
    'log',
    '--format=%s',
    `main..${ref}`,
  ]);
  return stdout.split('\n').filter(Boolean);
}

async function getCommitShas(ref: string): Promise<string[]> {
  const { stdout } = await gitInRepo(dir, [
    'log',
    '--format=%H',
    `main..${ref}`,
  ]);
  return stdout.split('\n').filter(Boolean);
}

describe('reorder command', () => {
  it('reorders 3 commits A,B,C → C,B,A in branch history', async () => {
    await create('feat/branch', dir);
    await commitFile('a.txt', 'A', 'A');
    await commitFile('b.txt', 'B', 'B');
    await commitFile('c.txt', 'C', 'C');

    // git log returns newest first: C, B, A
    expect(await getCommitSubjects('feat/branch')).toEqual(['C', 'B', 'A']);

    const shas = await getCommitShas('feat/branch'); // newest-first: [C, B, A]
    // todo entries are oldest-first: A, B, C → we want C, B, A in history
    // (newest = C → oldest in todo). Reverse the desired order to oldest-first.
    // New history (newest-first): A, B, C → todo (oldest-first): C, B, A
    const entries: RebaseTodoEntry[] = [
      { sha: shas[0], action: 'pick' }, // C oldest in new history
      { sha: shas[1], action: 'pick' }, // B middle
      { sha: shas[2], action: 'pick' }, // A newest
    ];

    const result = await reorder(dir, { entries });
    expect(result.status).toBe('success');
    expect(result.dropped).toEqual([]);

    expect(await getCommitSubjects('feat/branch')).toEqual(['A', 'B', 'C']);
  });

  it('drops the middle commit; remaining commits in order without it', async () => {
    await create('feat/branch', dir);
    await commitFile('a.txt', 'A', 'A');
    await commitFile('b.txt', 'B', 'B');
    await commitFile('c.txt', 'C', 'C');

    const shas = await getCommitShas('feat/branch'); // [C, B, A]
    const entries: RebaseTodoEntry[] = [
      { sha: shas[2], action: 'pick' }, // A oldest
      { sha: shas[1], action: 'drop' }, // B drop
      { sha: shas[0], action: 'pick' }, // C newest
    ];

    const result = await reorder(dir, { entries });
    expect(result.status).toBe('success');
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]).toBe(shas[1]);

    expect(await getCommitSubjects('feat/branch')).toEqual(['C', 'A']);
    // b.txt was introduced by the dropped commit and should be gone.
    expect(fs.existsSync(path.join(dir, 'b.txt'))).toBe(false);
  });

  it('undoes a reorder, restoring original commit order', async () => {
    await create('feat/branch', dir);
    await commitFile('a.txt', 'A', 'A');
    await commitFile('b.txt', 'B', 'B');
    await commitFile('c.txt', 'C', 'C');

    const originalTip = await getBranchTip('feat/branch', dir);
    const shas = await getCommitShas('feat/branch'); // [C, B, A]

    const entries: RebaseTodoEntry[] = [
      { sha: shas[0], action: 'pick' }, // C oldest in new history
      { sha: shas[1], action: 'pick' },
      { sha: shas[2], action: 'pick' },
    ];

    await reorder(dir, { entries });
    expect(await getCommitSubjects('feat/branch')).toEqual(['A', 'B', 'C']);

    const undoResult = await undo(dir);
    expect(undoResult.undone).toBe('reorder');

    expect(await getBranchTip('feat/branch', dir)).toBe(originalTip);
    expect(await getCommitSubjects('feat/branch')).toEqual(['C', 'B', 'A']);
  });

  it('returns no-op when the picker does not change anything', async () => {
    await create('feat/branch', dir);
    await commitFile('a.txt', 'A', 'A');
    await commitFile('b.txt', 'B', 'B');

    const originalTip = await getBranchTip('feat/branch', dir);
    const shas = await getCommitShas('feat/branch'); // [B, A]

    const entries: RebaseTodoEntry[] = [
      { sha: shas[1], action: 'pick' }, // A oldest
      { sha: shas[0], action: 'pick' }, // B newest
    ];

    const result = await reorder(dir, { entries });
    expect(result.status).toBe('no-op');
    // Tip unchanged — no rebase ran.
    expect(await getBranchTip('feat/branch', dir)).toBe(originalTip);
  });

  it('routes conflict path through restackConflictPrompt — cancel rolls back', async () => {
    // Two commits that both touch the same file with the same line → swapping
    // them while preserving content forces a conflict on the second `pick`.
    await create('feat/branch', dir);
    fs.writeFileSync(path.join(dir, 'shared.txt'), 'first\n');
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'A']);

    fs.writeFileSync(path.join(dir, 'shared.txt'), 'second\n');
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'B']);

    const originalTip = await getBranchTip('feat/branch', dir);
    const shas = await getCommitShas('feat/branch'); // [B, A]
    // Reverse to force a conflict: try to apply B before A.
    const entries: RebaseTodoEntry[] = [
      { sha: shas[0], action: 'pick' }, // B first
      { sha: shas[1], action: 'pick' }, // A second
    ];

    const promptCalls: string[] = [];
    const result = await reorder(dir, {
      entries,
      promptConflict: async (branch) => {
        promptCalls.push(branch);
        return 'cancel';
      },
    });

    expect(promptCalls).toEqual(['feat/branch']);
    expect(result.status).toBe('cancelled');
    // Cancel-and-rollback restores the original branch tip.
    expect(await getBranchTip('feat/branch', dir)).toBe(originalTip);
  });
});
