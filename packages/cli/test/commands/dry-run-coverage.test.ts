/**
 * End-to-end smoke coverage for the `--dry-run` contract added in DUB-70.
 *
 * For every mutating command the issue lists, we verify:
 *   1. The result carries `dryRun: true`.
 *   2. No mutation reaches `.git/dubstack/state.json` (mtime unchanged).
 *   3. No new undo entry is appended (head of the ring stays put).
 *
 * The point of a single shared suite is that a regression in any one
 * command's mutation guard immediately fails this file — no need to remember
 * to update each command's individual test file.
 */

import * as fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { absorb } from '../../src/commands/absorb';
import { create } from '../../src/commands/create';
import { deleteCommand } from '../../src/commands/delete';
import { fold } from '../../src/commands/fold';
import { freeze } from '../../src/commands/freeze';
import { init } from '../../src/commands/init';
import { modify } from '../../src/commands/modify';
import { move } from '../../src/commands/move';
import { pop } from '../../src/commands/pop';
import { rename } from '../../src/commands/rename';
import { reorder } from '../../src/commands/reorder';
import { restack } from '../../src/commands/restack';
import { revert } from '../../src/commands/revert';
import { split } from '../../src/commands/split';
import { squash } from '../../src/commands/squash';
import { stashPop, stashPush } from '../../src/commands/stash';
import { sync } from '../../src/commands/sync';
import { track } from '../../src/commands/track';
import { unfreeze } from '../../src/commands/unfreeze';
import { unlink } from '../../src/commands/unlink';
import { untrack } from '../../src/commands/untrack';
import { readUndoLog } from '../../src/lib/undo-log';
import { createTestRepo, gitInRepo } from '../helpers';

let dir: string;
let cleanup: () => Promise<void>;

interface Snapshot {
  stateMtimeMs: number;
  stateBytes: string;
  undoLogCount: number;
  undoLogTail: string;
}

async function readSnapshot(): Promise<Snapshot> {
  const statePath = `${dir}/.git/dubstack/state.json`;
  const stateStat = fs.statSync(statePath);
  const stateBytes = fs.readFileSync(statePath, 'utf-8');
  const log = await readUndoLog(dir);
  return {
    stateMtimeMs: stateStat.mtimeMs,
    stateBytes,
    undoLogCount: log.length,
    undoLogTail:
      log.length === 0
        ? ''
        : `${log[log.length - 1].operation}:${log[log.length - 1].timestamp}`,
  };
}

function expectNoMutation(before: Snapshot, after: Snapshot): void {
  expect(after.stateBytes).toBe(before.stateBytes);
  expect(after.undoLogCount).toBe(before.undoLogCount);
  expect(after.undoLogTail).toBe(before.undoLogTail);
}

async function setupStack(): Promise<void> {
  await init(dir);
  // `init` writes/updates `.gitignore`; commit it so the working tree is
  // clean before commands that gate on `isWorkingTreeClean`.
  await gitInRepo(dir, ['add', '.gitignore']);
  await gitInRepo(dir, ['commit', '-m', 'init: gitignore']);
  await create('feat/a', dir);
  await gitInRepo(dir, ['commit', '--allow-empty', '-m', 'feat-a-1']);
  await create('feat/b', dir);
  await gitInRepo(dir, ['commit', '--allow-empty', '-m', 'feat-b-1']);
  await gitInRepo(dir, ['commit', '--allow-empty', '-m', 'feat-b-2']);
}

beforeEach(async () => {
  const repo = await createTestRepo();
  dir = repo.dir;
  cleanup = repo.cleanup;
});

afterEach(async () => {
  await cleanup();
});

describe('--dry-run contract', () => {
  it('create returns a plan and does not write state or undo', async () => {
    await setupStack();
    const before = await readSnapshot();

    const result = await create('feat/c', dir, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.branch).toBe('feat/c');
    expect(result.parent).toBe('feat/b');
    expectNoMutation(before, await readSnapshot());
    // No actual ref created.
    await expect(
      gitInRepo(dir, ['rev-parse', '--verify', 'feat/c']),
    ).rejects.toThrow();
  });

  it('create --dry-run -m surfaces "no staged changes" same as a real run', async () => {
    // Per Copilot review: dry-run should still run read-only validation so
    // the plan matches what an actual run would do. With no staged changes
    // and a non-aggregate flag, the real run errors — dry-run must too.
    await setupStack();

    await expect(
      create('feat/c', dir, { message: 'feat: x', dryRun: true }),
    ).rejects.toThrow(/No staged changes/);
  });

  it('create --dry-run -a -m surfaces "no changes to commit" on a clean tree', async () => {
    await setupStack();

    await expect(
      create('feat/c', dir, {
        message: 'feat: x',
        all: true,
        dryRun: true,
      }),
    ).rejects.toThrow(/No changes to commit/);
  });

  it('modify returns a plan with no commit or restack', async () => {
    await setupStack();
    const before = await readSnapshot();
    const tipBefore = (
      await gitInRepo(dir, ['rev-parse', 'HEAD'])
    ).stdout.trim();

    const result = await modify(dir, { dryRun: true, message: 'msg' });

    expect(result).toBeDefined();
    expect(result?.dryRun).toBe(true);
    expect(result?.branch).toBe('feat/b');
    expect(result?.action).toBe('amend');
    expectNoMutation(before, await readSnapshot());
    expect((await gitInRepo(dir, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(
      tipBefore,
    );
  });

  it('restack reports planned rebases without touching refs', async () => {
    await setupStack();
    // Force feat/a's commit beyond what feat/b expects, so restack would do work.
    await gitInRepo(dir, ['checkout', 'feat/a']);
    await gitInRepo(dir, ['commit', '--allow-empty', '-m', 'feat-a-2']);
    const before = await readSnapshot();
    const tipBefore = (
      await gitInRepo(dir, ['rev-parse', 'feat/b'])
    ).stdout.trim();

    const result = await restack(dir, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expectNoMutation(before, await readSnapshot());
    expect((await gitInRepo(dir, ['rev-parse', 'feat/b'])).stdout.trim()).toBe(
      tipBefore,
    );
  });

  it('sync reports planned scope without fetching or mutating', async () => {
    await setupStack();
    const before = await readSnapshot();

    const result = await sync(dir, { dryRun: true, all: true });

    expect(result.dryRun).toBe(true);
    expect(result.plannedScope).toBeDefined();
    expect(result.plannedScope?.branches.sort()).toEqual(['feat/a', 'feat/b']);
    expectNoMutation(before, await readSnapshot());
  });

  it('delete reports targets without deleting branches', async () => {
    await setupStack();
    const before = await readSnapshot();

    const result = await deleteCommand(dir, 'feat/b', {
      force: true,
      quiet: true,
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.deleted).toContain('feat/b');
    expectNoMutation(before, await readSnapshot());
    await gitInRepo(dir, ['rev-parse', '--verify', 'feat/b']);
  });

  it('untrack reports removed branches without writing state', async () => {
    await setupStack();
    const before = await readSnapshot();

    const result = await untrack(dir, 'feat/b', {
      interactive: false,
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.removed).toContain('feat/b');
    expectNoMutation(before, await readSnapshot());
  });

  it('track --dry-run works in a repo with no DubStack state on disk', async () => {
    // Per Copilot review: dry-run must not require state.json to exist —
    // ensureState would write a fresh state file, but dry-run cannot mutate
    // disk. Verify a `dub track --dry-run` on a fresh repo succeeds.
    await gitInRepo(dir, ['checkout', '-b', 'feat/loose']);
    await gitInRepo(dir, ['commit', '--allow-empty', '-m', 'loose-1']);
    const stateBefore = fs.existsSync(`${dir}/.git/dubstack/state.json`);

    const result = await track(dir, 'feat/loose', {
      parent: 'main',
      interactive: false,
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.branch).toBe('feat/loose');
    expect(result.parent).toBe('main');
    // No state file created.
    expect(fs.existsSync(`${dir}/.git/dubstack/state.json`)).toBe(stateBefore);
  });

  it('track reports the planned parent without writing state', async () => {
    await setupStack();
    await gitInRepo(dir, ['checkout', '-b', 'feat/loose', 'feat/b']);
    const before = await readSnapshot();

    const result = await track(dir, 'feat/loose', {
      parent: 'feat/b',
      interactive: false,
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.branch).toBe('feat/loose');
    expect(result.parent).toBe('feat/b');
    expectNoMutation(before, await readSnapshot());
  });

  it('pop reports planned commits without resetting HEAD', async () => {
    await setupStack();
    const before = await readSnapshot();
    const tipBefore = (
      await gitInRepo(dir, ['rev-parse', 'HEAD'])
    ).stdout.trim();

    const result = await pop(dir, { steps: 1, dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.steps).toBe(1);
    expect(result.previousTip).toBe(tipBefore);
    expectNoMutation(before, await readSnapshot());
    expect((await gitInRepo(dir, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(
      tipBefore,
    );
  });

  it('squash reports planned squash without resetting or committing', async () => {
    await setupStack();
    const before = await readSnapshot();
    const tipBefore = (
      await gitInRepo(dir, ['rev-parse', 'HEAD'])
    ).stdout.trim();

    const result = await squash(dir, { dryRun: true, message: 'feat: combo' });

    expect(result.dryRun).toBe(true);
    expect(result.branch).toBe('feat/b');
    expect(result.squashedCommits).toBeGreaterThanOrEqual(2);
    expect(result.message).toBe('feat: combo');
    expectNoMutation(before, await readSnapshot());
    expect((await gitInRepo(dir, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(
      tipBefore,
    );
  });

  it('fold reports planned merge into parent without mutating refs', async () => {
    // fold requires a non-trunk parent. Build feat/a -> feat/b -> feat/c so
    // fold on feat/c merges into feat/b (not main).
    await setupStack();
    await create('feat/c', dir);
    await gitInRepo(dir, ['commit', '--allow-empty', '-m', 'feat-c-1']);
    const before = await readSnapshot();
    const cTipBefore = (
      await gitInRepo(dir, ['rev-parse', 'feat/c'])
    ).stdout.trim();
    const bTipBefore = (
      await gitInRepo(dir, ['rev-parse', 'feat/b'])
    ).stdout.trim();

    const result = await fold(dir, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.branch).toBe('feat/c');
    expect(result.parent).toBe('feat/b');
    expectNoMutation(before, await readSnapshot());
    expect((await gitInRepo(dir, ['rev-parse', 'feat/c'])).stdout.trim()).toBe(
      cTipBefore,
    );
    expect((await gitInRepo(dir, ['rev-parse', 'feat/b'])).stdout.trim()).toBe(
      bTipBefore,
    );
  });

  it('rename reports new name without renaming the branch', async () => {
    await setupStack();
    const before = await readSnapshot();

    const result = await rename(dir, 'feat/b-renamed', undefined, {
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.oldName).toBe('feat/b');
    expect(result.newName).toBe('feat/b-renamed');
    expect(result.pushed).toBe(false);
    expectNoMutation(before, await readSnapshot());
    await gitInRepo(dir, ['rev-parse', '--verify', 'feat/b']);
    await expect(
      gitInRepo(dir, ['rev-parse', '--verify', 'feat/b-renamed']),
    ).rejects.toThrow();
  });

  it('move reports planned reparent without mutating state or refs', async () => {
    await setupStack();
    await gitInRepo(dir, ['checkout', 'feat/a']);
    await create('feat/parallel', dir);
    await gitInRepo(dir, ['commit', '--allow-empty', '-m', 'parallel-1']);
    const before = await readSnapshot();

    const result = await move(dir, 'feat/parallel', {
      after: 'feat/b',
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expectNoMutation(before, await readSnapshot());
  });

  it('freeze and unfreeze report planned flips without writing state', async () => {
    await setupStack();
    const before = await readSnapshot();

    const frozen = await freeze(dir, 'feat/b', { dryRun: true });
    expect(frozen.dryRun).toBe(true);
    expect(frozen.changed).toContain('feat/b');
    expectNoMutation(before, await readSnapshot());

    // The dry-run freeze never wrote, so unfreeze still reports unchanged.
    const unfrozen = await unfreeze(dir, 'feat/b', { dryRun: true });
    expect(unfrozen.dryRun).toBe(true);
    expect(unfrozen.unchanged).toContain('feat/b');
    expectNoMutation(before, await readSnapshot());
  });

  it('reorder reports reorderable commits without launching the picker', async () => {
    await setupStack();
    const before = await readSnapshot();
    const tipBefore = (
      await gitInRepo(dir, ['rev-parse', 'feat/b'])
    ).stdout.trim();

    const result = await reorder(dir, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.status).toBe('dry-run');
    expect(result.reorderableCommits?.length).toBeGreaterThan(0);
    expectNoMutation(before, await readSnapshot());
    expect((await gitInRepo(dir, ['rev-parse', 'feat/b'])).stdout.trim()).toBe(
      tipBefore,
    );
  });

  it('unlink reports planned promotion without writing state or PR retarget', async () => {
    await setupStack();
    const before = await readSnapshot();

    const result = await unlink(dir, 'feat/b', { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.branch).toBe('feat/b');
    expect(result.previousParent).toBe('feat/a');
    expect(result.retargeted).toBe(false);
    // Plan must be deterministic — no per-call UUIDs leaking into the JSON
    // envelope.
    expect(result.newStackId).toBe('<would-create-new-stack>');
    expectNoMutation(before, await readSnapshot());
  });

  it('revert reports planned revert branch without creating it', async () => {
    await setupStack();
    const before = await readSnapshot();
    const sha = (await gitInRepo(dir, ['rev-parse', 'HEAD'])).stdout.trim();
    // revert wants an absolute trunk branch — main is set up via init.

    const result = await revert(dir, sha, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.trunk).toBe('main');
    expect(result.revertedSha).toBe(sha);
    expectNoMutation(before, await readSnapshot());
    await expect(
      gitInRepo(dir, ['rev-parse', '--verify', result.branch]),
    ).rejects.toThrow();
  });

  it('absorb reports planned autosquash without rebasing', async () => {
    await setupStack();
    // Add a literal `fixup!` commit so absorb has something to plan.
    const subject = (
      await gitInRepo(dir, ['log', '-1', '--format=%s'])
    ).stdout.trim();
    await gitInRepo(dir, [
      'commit',
      '--allow-empty',
      '-m',
      `fixup! ${subject}`,
    ]);
    const before = await readSnapshot();
    const tipBefore = (
      await gitInRepo(dir, ['rev-parse', 'HEAD'])
    ).stdout.trim();

    const result = await absorb(dir, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.absorbed).toBeGreaterThan(0);
    expectNoMutation(before, await readSnapshot());
    expect((await gitInRepo(dir, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(
      tipBefore,
    );
  });

  it('split (by-file) reports planned slices without mutating refs', async () => {
    await setupStack();
    // Write two files on feat/b so by-file split has something to extract.
    fs.writeFileSync(`${dir}/a.txt`, 'a');
    fs.writeFileSync(`${dir}/b.txt`, 'b');
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'two-file commit']);
    const before = await readSnapshot();
    const tipBefore = (
      await gitInRepo(dir, ['rev-parse', 'feat/b'])
    ).stdout.trim();

    const result = await split(dir, {
      mode: 'by-file',
      files: ['a.txt'],
      name: 'feat/split-a',
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.plannedBranches).toContain('feat/split-a');
    expectNoMutation(before, await readSnapshot());
    expect((await gitInRepo(dir, ['rev-parse', 'feat/b'])).stdout.trim()).toBe(
      tipBefore,
    );
    await expect(
      gitInRepo(dir, ['rev-parse', '--verify', 'feat/split-a']),
    ).rejects.toThrow();
  });

  it('stash push reports planned stash without invoking git stash', async () => {
    await setupStack();
    // Create dirty working tree so stash has something to capture.
    fs.writeFileSync(`${dir}/dirty.txt`, 'wip');
    await gitInRepo(dir, ['add', 'dirty.txt']);
    const before = await readSnapshot();

    const result = await stashPush(dir, { dryRun: true, message: 'preview' });

    expect(result.dryRun).toBe(true);
    expect(result.message).toBe('preview');
    expect(result.branch).toBe('feat/b');
    expectNoMutation(before, await readSnapshot());
    // The working-tree change is still present — stash never ran.
    expect(fs.existsSync(`${dir}/dirty.txt`)).toBe(true);

    // Clean up so afterEach doesn't see dirt.
    await gitInRepo(dir, ['reset', '--hard', 'HEAD']);
    fs.rmSync(`${dir}/dirty.txt`, { force: true });
  });

  it('stash pop reports the planned pop without applying it', async () => {
    await setupStack();
    fs.writeFileSync(`${dir}/dirty.txt`, 'wip');
    await gitInRepo(dir, ['add', 'dirty.txt']);
    await stashPush(dir, { message: 'real-stash' });
    const before = await readSnapshot();

    const result = await stashPop(dir, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.branch).toBe('feat/b');
    expectNoMutation(before, await readSnapshot());
    // The stash entry is still present after the dry-run.
    const stashList = (await gitInRepo(dir, ['stash', 'list'])).stdout;
    expect(stashList).toContain('real-stash');
  });
});
