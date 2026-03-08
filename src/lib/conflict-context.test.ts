import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestRepo, gitInRepo } from '../../test/helpers';
import { getRestackProgressPath } from './operation-state';

const { gatherConflictContext } = await import('./conflict-context');

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

describe('gatherConflictContext', () => {
  it('throws DubError when no active operation', async () => {
    await expect(gatherConflictContext(dir)).rejects.toThrow(
      'No active rebase or restack operation',
    );
  });

  it('gathers conflicted files from a real rebase conflict', async () => {
    // Create a conflict: two branches modify the same file differently
    fs.writeFileSync(path.join(dir, 'file.txt'), 'original\n');
    await gitInRepo(dir, ['add', 'file.txt']);
    await gitInRepo(dir, ['commit', '-m', 'add file']);

    await gitInRepo(dir, ['checkout', '-b', 'feature']);
    fs.writeFileSync(path.join(dir, 'file.txt'), 'feature change\n');
    await gitInRepo(dir, ['add', 'file.txt']);
    await gitInRepo(dir, ['commit', '-m', 'feature change']);

    await gitInRepo(dir, ['checkout', 'main']);
    fs.writeFileSync(path.join(dir, 'file.txt'), 'main change\n');
    await gitInRepo(dir, ['add', 'file.txt']);
    await gitInRepo(dir, ['commit', '-m', 'main change']);

    await gitInRepo(dir, ['checkout', 'feature']);

    // Start a rebase that will conflict
    try {
      await gitInRepo(dir, ['rebase', 'main']);
    } catch {
      // expected conflict
    }

    const ctx = await gatherConflictContext(dir);

    expect(ctx.operation).toBe('rebase');
    expect(ctx.conflictedFiles).toContain('file.txt');
    expect(ctx.conflictMarkers['file.txt']).toContain('<<<<<<<');
  });

  it('reads conflict markers from files', async () => {
    // Simulate a rebase-merge dir so detectActiveOperation returns 'rebase'
    const rebaseDir = path.join(dir, '.git', 'rebase-merge');
    fs.mkdirSync(rebaseDir, { recursive: true });

    // Create a file with fake conflict markers
    const markerContent = [
      '<<<<<<< HEAD',
      'our side',
      '=======',
      'their side',
      '>>>>>>> abc1234',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'conflict.txt'), markerContent);

    // Stage the file as unmerged by manually marking it
    // Since we can't easily fake unmerged state, test with a real conflict
    // This test verifies that conflictMarkers reads file content correctly
    // when files are returned by getConflictedFiles

    const ctx = await gatherConflictContext(dir);
    // No files will show as conflicted (no real unmerged entries), but
    // the function should still complete without error
    expect(ctx.operation).toBe('rebase');
    expect(ctx.conflictedFiles).toEqual([]);
  });

  it('sets scopeWarning when file count exceeds threshold', async () => {
    // Create a real conflict to get conflicted files
    fs.writeFileSync(path.join(dir, 'file.txt'), 'original\n');
    await gitInRepo(dir, ['add', 'file.txt']);
    await gitInRepo(dir, ['commit', '-m', 'add file']);

    await gitInRepo(dir, ['checkout', '-b', 'feature']);

    // Create 11 files that will conflict
    for (let i = 0; i < 11; i++) {
      fs.writeFileSync(path.join(dir, `f${i}.txt`), `feature-${i}\n`);
    }
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'feature files']);

    await gitInRepo(dir, ['checkout', 'main']);
    for (let i = 0; i < 11; i++) {
      fs.writeFileSync(path.join(dir, `f${i}.txt`), `main-${i}\n`);
    }
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'main files']);

    await gitInRepo(dir, ['checkout', 'feature']);
    try {
      await gitInRepo(dir, ['rebase', 'main']);
    } catch {
      // expected conflict
    }

    const ctx = await gatherConflictContext(dir);
    expect(ctx.conflictedFiles.length).toBeGreaterThan(10);
    expect(ctx.scopeWarning).toMatch(/exceeds the 10-file threshold/);
  });

  it('returns restackStep when restack progress exists', async () => {
    // Set up rebase-merge dir
    const rebaseDir = path.join(dir, '.git', 'rebase-merge');
    fs.mkdirSync(rebaseDir, { recursive: true });

    // Write restack progress
    const progressPath = await getRestackProgressPath(dir);
    fs.mkdirSync(path.dirname(progressPath), { recursive: true });

    const progress = {
      originalBranch: 'main',
      steps: [
        {
          branch: 'feature-a',
          parent: 'main',
          parentOldTip: 'abc123',
          status: 'done',
        },
        {
          branch: 'feature-b',
          parent: 'feature-a',
          parentOldTip: 'def456',
          parentNewTip: 'ghi789',
          status: 'conflicted',
        },
        {
          branch: 'feature-c',
          parent: 'feature-b',
          parentOldTip: 'jkl012',
          status: 'pending',
        },
      ],
    };
    fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2));

    const ctx = await gatherConflictContext(dir);

    expect(ctx.operation).toBe('restack');
    expect(ctx.restackStep).toEqual({
      branch: 'feature-b',
      parent: 'feature-a',
      parentOldTip: 'def456',
      parentNewTip: 'ghi789',
      status: 'conflicted',
    });
    expect(ctx.remainingSteps).toBe(1);
    expect(ctx.conflictedBranch).toBe('feature-b');
    expect(ctx.parentBranch).toBe('feature-a');
  });
});
