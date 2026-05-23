import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  attachBareRemote,
  createTestRepo,
  gitInRepo,
} from '../../test/helpers';
import { DubError } from './errors';
import {
  branchExists,
  checkoutBranch,
  clearStaleNamespacedFetchRefs,
  commitStaged,
  commitStagedFromFile,
  createBranch,
  DUBSTACK_FETCH_REF_PREFIX,
  deleteBranch,
  fastForwardBranchToRef,
  fetchBranches,
  forceBranchTo,
  getBranchTip,
  getCurrentBranch,
  getDiffBetween,
  getMergeBase,
  hardResetBranchToRef,
  hasStagedChanges,
  hasUniquePatchCommits,
  isGitRepo,
  isValidBranchName,
  isWorkingTreeClean,
  lastPushedRef,
  listNamespacedFetchRefs,
  listWorktreeCheckouts,
  namespacedFetchRef,
  pruneRemote,
  pushBranch,
  readLastPushedSha,
  rebaseOnto,
  stageAll,
} from './git';

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

describe('isGitRepo', () => {
  it('returns true inside a git repository', async () => {
    expect(await isGitRepo(dir)).toBe(true);
  });

  it('returns false in a plain directory', async () => {
    const tmpDir = await fs.promises.mkdtemp('/tmp/dubstack-nongit-');
    try {
      expect(await isGitRepo(tmpDir)).toBe(false);
    } finally {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('getCurrentBranch', () => {
  it("returns 'main' on a fresh repo", async () => {
    expect(await getCurrentBranch(dir)).toBe('main');
  });

  it('throws on detached HEAD', async () => {
    await gitInRepo(dir, ['checkout', '--detach']);
    await expect(getCurrentBranch(dir)).rejects.toThrow(DubError);
    await expect(getCurrentBranch(dir)).rejects.toThrow('detached');
  });
});

describe('listWorktreeCheckouts', () => {
  it('returns an empty map for a single worktree', async () => {
    expect(await listWorktreeCheckouts(dir)).toEqual(new Map());
  });

  it('returns branches checked out in another worktree', async () => {
    await gitInRepo(dir, ['checkout', '-b', 'feat/worktree']);
    await gitInRepo(dir, ['checkout', 'main']);
    const worktreeDir = `${dir}-feat-worktree`;

    try {
      await gitInRepo(dir, ['worktree', 'add', worktreeDir, 'feat/worktree']);
      const gitWorktreePath = await fs.promises.realpath(worktreeDir);
      const gitMainPath = await fs.promises.realpath(dir);

      expect(await listWorktreeCheckouts(dir)).toEqual(
        new Map([['feat/worktree', gitWorktreePath]]),
      );
      expect(await listWorktreeCheckouts(worktreeDir)).toEqual(
        new Map([['main', gitMainPath]]),
      );
    } finally {
      await gitInRepo(dir, [
        'worktree',
        'remove',
        '--force',
        worktreeDir,
      ]).catch(() => {});
      await fs.promises.rm(worktreeDir, { recursive: true, force: true });
    }
  });
});

describe('branchExists', () => {
  it('returns true for an existing branch', async () => {
    expect(await branchExists('main', dir)).toBe(true);
  });

  it('returns false for a nonexistent branch', async () => {
    expect(await branchExists('nonexistent', dir)).toBe(false);
  });
});

describe('isValidBranchName', () => {
  it('returns true for a valid branch name', async () => {
    expect(await isValidBranchName('feat/valid-name', dir)).toBe(true);
  });

  it('returns false for an invalid branch name', async () => {
    expect(await isValidBranchName('feat with spaces', dir)).toBe(false);
  });
});

describe('createBranch', () => {
  it('creates a new branch and switches to it', async () => {
    await createBranch('feat/test', dir);
    expect(await getCurrentBranch(dir)).toBe('feat/test');
    expect(await branchExists('feat/test', dir)).toBe(true);
  });

  it('throws if branch already exists', async () => {
    await createBranch('feat/test', dir);
    await gitInRepo(dir, ['checkout', 'main']);
    await expect(createBranch('feat/test', dir)).rejects.toThrow(DubError);
    await expect(createBranch('feat/test', dir)).rejects.toThrow(
      'already exists',
    );
    expect(await getCurrentBranch(dir)).toBe('main');
  });
});

describe('checkoutBranch', () => {
  it('throws a detailed error when checkout is blocked by local changes', async () => {
    fs.writeFileSync(path.join(dir, 'shared.txt'), 'main');
    await gitInRepo(dir, ['add', 'shared.txt']);
    await gitInRepo(dir, ['commit', '-m', 'add shared file']);

    await gitInRepo(dir, ['checkout', '-b', 'feat/checkout-blocked']);
    fs.writeFileSync(path.join(dir, 'shared.txt'), 'feat');
    await gitInRepo(dir, ['add', 'shared.txt']);
    await gitInRepo(dir, ['commit', '-m', 'feat change']);

    await gitInRepo(dir, ['checkout', 'main']);
    fs.writeFileSync(path.join(dir, 'shared.txt'), 'dirty');

    await expect(checkoutBranch('feat/checkout-blocked', dir)).rejects.toThrow(
      "Failed to checkout branch 'feat/checkout-blocked'.",
    );
    await expect(
      checkoutBranch('feat/checkout-blocked', dir),
    ).rejects.not.toThrow("Branch 'feat/checkout-blocked' not found.");
  });
});

describe('isWorkingTreeClean', () => {
  it('returns true on a clean repo', async () => {
    expect(await isWorkingTreeClean(dir)).toBe(true);
  });

  it('returns false with an untracked file', async () => {
    fs.writeFileSync(path.join(dir, 'dirty.txt'), 'dirty');
    expect(await isWorkingTreeClean(dir)).toBe(false);
  });
});

describe('rebaseOnto', () => {
  it('succeeds on a clean rebase', async () => {
    // main: init -> base-commit
    // feat: init -> feat-commit
    // Rebase feat onto main (which has base-commit)
    await gitInRepo(dir, ['checkout', '-b', 'feat']);
    fs.writeFileSync(path.join(dir, 'feat.txt'), 'feat');
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'feat-commit']);

    await gitInRepo(dir, ['checkout', 'main']);
    fs.writeFileSync(path.join(dir, 'base.txt'), 'base');
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'base-commit']);

    const oldBase = (
      await gitInRepo(dir, ['merge-base', 'main', 'feat'])
    ).stdout.trim();
    const mainTip = (await gitInRepo(dir, ['rev-parse', 'main'])).stdout.trim();

    await rebaseOnto(mainTip, oldBase, 'feat', dir);

    // After rebase, feat should have both base.txt and feat.txt
    await gitInRepo(dir, ['checkout', 'feat']);
    expect(fs.existsSync(path.join(dir, 'base.txt'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'feat.txt'))).toBe(true);
  });

  it('throws on conflicting commits', async () => {
    await gitInRepo(dir, ['checkout', '-b', 'feat']);
    fs.writeFileSync(path.join(dir, 'conflict.txt'), 'feat-version');
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'feat-commit']);

    await gitInRepo(dir, ['checkout', 'main']);
    fs.writeFileSync(path.join(dir, 'conflict.txt'), 'main-version');
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'main-commit']);

    const oldBase = (
      await gitInRepo(dir, ['merge-base', 'main', 'feat'])
    ).stdout.trim();
    const mainTip = (await gitInRepo(dir, ['rev-parse', 'main'])).stdout.trim();

    await expect(rebaseOnto(mainTip, oldBase, 'feat', dir)).rejects.toThrow(
      DubError,
    );
    await expect(rebaseOnto(mainTip, oldBase, 'feat', dir)).rejects.toThrow(
      'Conflict',
    );

    // Clean up the failed rebase
    await gitInRepo(dir, ['rebase', '--abort']).catch(() => {});
  });
});

describe('getMergeBase', () => {
  it('returns the correct common ancestor', async () => {
    const initTip = (await gitInRepo(dir, ['rev-parse', 'HEAD'])).stdout.trim();

    await gitInRepo(dir, ['checkout', '-b', 'feat']);
    fs.writeFileSync(path.join(dir, 'feat.txt'), 'feat');
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'feat-commit']);

    await gitInRepo(dir, ['checkout', 'main']);
    fs.writeFileSync(path.join(dir, 'main.txt'), 'main');
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'main-commit']);

    const base = await getMergeBase('main', 'feat', dir);
    expect(base).toBe(initTip);
  });
});

describe('getDiffBetween', () => {
  it('throws when either ref is invalid', async () => {
    await expect(getDiffBetween('main', 'missing-branch', dir)).rejects.toThrow(
      DubError,
    );
  });
});

describe('hasUniquePatchCommits', () => {
  it('returns true when a branch has unique work not present upstream', async () => {
    await gitInRepo(dir, ['checkout', '-b', 'feat']);
    fs.writeFileSync(path.join(dir, 'feat.txt'), 'feature');
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'feat-commit']);

    await expect(hasUniquePatchCommits('main', 'feat', dir)).resolves.toBe(
      true,
    );
  });

  it('returns false when the branch changes were squash-merged upstream', async () => {
    await gitInRepo(dir, ['checkout', '-b', 'feat']);
    fs.writeFileSync(path.join(dir, 'feat.txt'), 'feature');
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'feat-commit']);

    await gitInRepo(dir, ['checkout', 'main']);
    await gitInRepo(dir, ['merge', '--squash', 'feat']);
    await gitInRepo(dir, ['commit', '-m', 'squash feat']);

    await expect(hasUniquePatchCommits('main', 'feat', dir)).resolves.toBe(
      false,
    );
  });
});

describe('getBranchTip', () => {
  it('returns the commit SHA of a branch', async () => {
    const expected = (
      await gitInRepo(dir, ['rev-parse', 'main'])
    ).stdout.trim();
    expect(await getBranchTip('main', dir)).toBe(expected);
  });

  it('throws for a nonexistent branch', async () => {
    await expect(getBranchTip('nonexistent', dir)).rejects.toThrow(DubError);
  });
});

describe('forceBranchTo', () => {
  it('resets a branch tip to a specific SHA', async () => {
    const originalTip = await getBranchTip('main', dir);

    fs.writeFileSync(path.join(dir, 'new.txt'), 'new');
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'new-commit']);

    const newTip = await getBranchTip('main', dir);
    expect(newTip).not.toBe(originalTip);

    await forceBranchTo('main', originalTip, dir);
    expect(await getBranchTip('main', dir)).toBe(originalTip);
  });
});

describe('fastForwardBranchToRef', () => {
  it('returns false only for true fast-forward conflicts', async () => {
    await gitInRepo(dir, ['checkout', '-b', 'feat/ff-target']);
    fs.writeFileSync(path.join(dir, 'ff.txt'), 'target');
    await gitInRepo(dir, ['add', 'ff.txt']);
    await gitInRepo(dir, ['commit', '-m', 'target commit']);

    await gitInRepo(dir, ['checkout', 'main']);
    fs.writeFileSync(path.join(dir, 'main.txt'), 'main');
    await gitInRepo(dir, ['add', 'main.txt']);
    await gitInRepo(dir, ['commit', '-m', 'main commit']);

    await expect(
      fastForwardBranchToRef('main', 'feat/ff-target', dir),
    ).resolves.toBe(false);
  });

  it('throws details for non-conflict failures', async () => {
    await expect(
      fastForwardBranchToRef('main', 'does-not-exist', dir),
    ).rejects.toThrow("Failed to fast-forward 'main' to 'does-not-exist'.");
  });
});

describe('hardResetBranchToRef', () => {
  it('includes root-cause details on reset failures', async () => {
    await expect(
      hardResetBranchToRef('main', 'does-not-exist', dir),
    ).rejects.toThrow("Failed to hard reset 'main' to 'does-not-exist'.");
  });
});

describe('deleteBranch', () => {
  it('removes a branch', async () => {
    await createBranch('to-delete', dir);
    await gitInRepo(dir, ['checkout', 'main']);
    await deleteBranch('to-delete', dir);
    expect(await branchExists('to-delete', dir)).toBe(false);
  });
});

describe('stageAll', () => {
  it('stages untracked and modified files', async () => {
    fs.writeFileSync(path.join(dir, 'new.txt'), 'new');
    await stageAll(dir);
    expect(await hasStagedChanges(dir)).toBe(true);
  });
});

describe('hasStagedChanges', () => {
  it('returns false on a clean repo', async () => {
    expect(await hasStagedChanges(dir)).toBe(false);
  });

  it('returns true after staging a file', async () => {
    fs.writeFileSync(path.join(dir, 'staged.txt'), 'content');
    await gitInRepo(dir, ['add', 'staged.txt']);
    expect(await hasStagedChanges(dir)).toBe(true);
  });
});

describe('commitStaged', () => {
  it('creates a commit with the given message', async () => {
    fs.writeFileSync(path.join(dir, 'commit-me.txt'), 'data');
    await gitInRepo(dir, ['add', 'commit-me.txt']);
    await commitStaged('test: add file', dir);

    const { stdout } = await gitInRepo(dir, ['log', '-1', '--format=%s']);
    expect(stdout.trim()).toBe('test: add file');
  });

  it('throws when nothing is staged', async () => {
    await expect(commitStaged('empty commit', dir)).rejects.toThrow(DubError);
  });
});

describe('pushBranch', () => {
  let remoteDir: string;
  let otherDir: string;

  beforeEach(async () => {
    remoteDir = await fs.promises.mkdtemp('/tmp/dubstack-remote-');
    await gitInRepo(remoteDir, ['init', '--bare', '-b', 'main']);
    await gitInRepo(dir, ['remote', 'add', 'origin', remoteDir]);

    fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed');
    await gitInRepo(dir, ['add', 'seed.txt']);
    await gitInRepo(dir, ['commit', '-m', 'seed']);
    await gitInRepo(dir, ['push', 'origin', 'main']);

    await createBranch('feat/lease', dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
    await gitInRepo(dir, ['add', 'a.txt']);
    await gitInRepo(dir, ['commit', '-m', 'feat: a']);
  });

  afterEach(async () => {
    await fs.promises.rm(remoteDir, { recursive: true, force: true });
    if (otherDir) {
      await fs.promises.rm(otherDir, { recursive: true, force: true });
      otherDir = '';
    }
  });

  it('pushes and records the last-pushed SHA on first push', async () => {
    expect(await readLastPushedSha('feat/lease', dir)).toBeNull();

    await pushBranch('feat/lease', dir);

    const head = await getBranchTip('feat/lease', dir);
    expect(await readLastPushedSha('feat/lease', dir)).toBe(head);

    const { stdout } = await gitInRepo(remoteDir, [
      'rev-parse',
      'refs/heads/feat/lease',
    ]);
    expect(stdout.trim()).toBe(head);
  });

  it('lease succeeds when our tracked SHA matches reality on remote', async () => {
    await pushBranch('feat/lease', dir);
    const firstSha = await getBranchTip('feat/lease', dir);

    fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
    await gitInRepo(dir, ['add', 'b.txt']);
    await gitInRepo(dir, ['commit', '-m', 'feat: b']);

    await expect(pushBranch('feat/lease', dir)).resolves.toBeUndefined();

    const newSha = await getBranchTip('feat/lease', dir);
    expect(newSha).not.toBe(firstSha);
    expect(await readLastPushedSha('feat/lease', dir)).toBe(newSha);

    const { stdout } = await gitInRepo(remoteDir, [
      'rev-parse',
      'refs/heads/feat/lease',
    ]);
    expect(stdout.trim()).toBe(newSha);
  });

  it('refuses with a lease error when a third party pushed concurrently', async () => {
    await pushBranch('feat/lease', dir);
    const trackedSha = await readLastPushedSha('feat/lease', dir);

    otherDir = await fs.promises.mkdtemp('/tmp/dubstack-other-');
    await gitInRepo(otherDir, ['clone', remoteDir, '.']);
    await gitInRepo(otherDir, ['config', 'user.name', 'Other User']);
    await gitInRepo(otherDir, ['config', 'user.email', 'other@dubstack.test']);
    await gitInRepo(otherDir, ['checkout', 'feat/lease']);
    fs.writeFileSync(path.join(otherDir, 'third-party.txt'), 'tp');
    await gitInRepo(otherDir, ['add', 'third-party.txt']);
    await gitInRepo(otherDir, ['commit', '-m', 'third party push']);
    await gitInRepo(otherDir, ['push', 'origin', 'feat/lease']);

    fs.writeFileSync(path.join(dir, 'c.txt'), 'c');
    await gitInRepo(dir, ['add', 'c.txt']);
    await gitInRepo(dir, ['commit', '-m', 'feat: c']);

    await gitInRepo(dir, ['fetch', 'origin', 'feat/lease']);

    const err = await pushBranch('feat/lease', dir).catch((e) => e);
    expect(err).toBeInstanceOf(DubError);
    expect(err.message).toMatch(
      /refused: remote has updates not reflected in our last-pushed ref/,
    );
    expect((err as DubError).recovery.join('\n')).toMatch(/dub sync/);

    expect(await readLastPushedSha('feat/lease', dir)).toBe(trackedSha);
  });
});

describe('lastPushedRef', () => {
  it('returns the dubstack ref path for a branch', () => {
    expect(lastPushedRef('feat/x')).toBe('refs/dubstack/last-pushed/feat/x');
  });
});

describe('readLastPushedSha', () => {
  it('returns null when the ref does not exist', async () => {
    expect(await readLastPushedSha('feat/never-pushed', dir)).toBeNull();
  });

  it('throws DubError when git rev-parse fails for a non-missing-ref reason', async () => {
    const tmpDir = await fs.promises.mkdtemp('/tmp/dubstack-nongit-');
    try {
      await expect(readLastPushedSha('feat/x', tmpDir)).rejects.toThrow(
        DubError,
      );
      await expect(readLastPushedSha('feat/x', tmpDir)).rejects.toThrow(
        /Failed to read last-pushed ref for 'feat\/x'/,
      );
    } finally {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('commitStagedFromFile', () => {
  it('creates a commit using a file-backed message', async () => {
    const messagePath = path.join(dir, 'commit-message.md');
    fs.writeFileSync(messagePath, 'test: add file from message file\n');
    fs.writeFileSync(path.join(dir, 'commit-file.txt'), 'data');
    await gitInRepo(dir, ['add', 'commit-file.txt']);

    await commitStagedFromFile(messagePath, dir);

    const { stdout } = await gitInRepo(dir, ['log', '-1', '--format=%s']);
    expect(stdout.trim()).toBe('test: add file from message file');
  });

  it('throws when the message file commit fails', async () => {
    const messagePath = path.join(dir, 'commit-message.md');
    fs.writeFileSync(messagePath, 'test: no staged changes\n');

    await expect(commitStagedFromFile(messagePath, dir)).rejects.toThrow(
      DubError,
    );
  });
});

describe('fetchBranches', () => {
  let remoteCleanup: () => Promise<void>;

  beforeEach(async () => {
    const remote = await attachBareRemote(dir);
    remoteCleanup = remote.cleanup;
    await gitInRepo(dir, ['push', 'origin', 'main']);
    await gitInRepo(dir, ['checkout', '-b', 'feat/a']);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'a']);
    await gitInRepo(dir, ['push', 'origin', 'feat/a']);
    await gitInRepo(dir, ['checkout', 'main']);
  });

  afterEach(async () => {
    await remoteCleanup();
  });

  it('writes fetched tip to refs/dubstack/fetch-head/<branch>', async () => {
    // Move remote forward so a fetch actually has work to do.
    await gitInRepo(dir, ['checkout', 'feat/a']);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a2');
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'a2']);
    await gitInRepo(dir, ['push', 'origin', 'feat/a']);
    const remoteSha = (
      await gitInRepo(dir, ['rev-parse', 'feat/a'])
    ).stdout.trim();
    // Reset local feat/a to simulate a "stale local" state.
    await gitInRepo(dir, ['reset', '--hard', 'HEAD^']);
    await gitInRepo(dir, ['checkout', 'main']);

    await fetchBranches(['feat/a'], dir);

    const namespaced = (
      await gitInRepo(dir, ['rev-parse', namespacedFetchRef('feat/a')])
    ).stdout.trim();
    expect(namespaced).toBe(remoteSha);
  });

  it('leaves the user FETCH_HEAD untouched (--no-write-fetch-head)', async () => {
    const fetchHeadPath = path.join(dir, '.git', 'FETCH_HEAD');
    const manualContent = 'sentinel value written by user\n';
    fs.writeFileSync(fetchHeadPath, manualContent);

    await fetchBranches(['feat/a'], dir);

    expect(fs.readFileSync(fetchHeadPath, 'utf8')).toBe(manualContent);
  });

  it('does not fetch remote tags (--no-tags)', async () => {
    // Tag a commit on the remote that should NOT be pulled in.
    await gitInRepo(dir, ['checkout', 'feat/a']);
    await gitInRepo(dir, ['tag', 'v9.9.9-test']);
    await gitInRepo(dir, ['push', 'origin', 'v9.9.9-test']);
    await gitInRepo(dir, ['tag', '-d', 'v9.9.9-test']);
    await gitInRepo(dir, ['checkout', 'main']);

    await fetchBranches(['feat/a'], dir);

    const { stdout } = await gitInRepo(dir, ['tag', '-l']);
    expect(stdout.trim()).toBe('');
  });

  it('skips missing remote refs without throwing', async () => {
    await expect(
      fetchBranches(['no-such-branch'], dir),
    ).resolves.toBeUndefined();
  });

  it('still opportunistically updates refs/remotes/origin/<branch>', async () => {
    // Downstream sync code reads origin/<branch> directly. With our
    // explicit refspec, git must keep that tracking ref in step via the
    // configured `+refs/heads/*:refs/remotes/origin/*` refspec. If a git
    // version or repo config ever breaks that invariant, this test fails.
    await gitInRepo(dir, ['checkout', 'feat/a']);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a-opportunistic');
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'a-opportunistic']);
    await gitInRepo(dir, ['push', 'origin', 'feat/a']);
    const remoteSha = (
      await gitInRepo(dir, ['rev-parse', 'feat/a'])
    ).stdout.trim();
    await gitInRepo(dir, ['reset', '--hard', 'HEAD^']);
    await gitInRepo(dir, ['checkout', 'main']);

    await fetchBranches(['feat/a'], dir);

    const trackingSha = (
      await gitInRepo(dir, ['rev-parse', 'refs/remotes/origin/feat/a'])
    ).stdout.trim();
    expect(trackingSha).toBe(remoteSha);
  });
});

describe('clearStaleNamespacedFetchRefs', () => {
  it('deletes refs whose source branch is not in the keep set', async () => {
    await gitInRepo(dir, [
      'update-ref',
      `${DUBSTACK_FETCH_REF_PREFIX}feat/keep`,
      'HEAD',
    ]);
    await gitInRepo(dir, [
      'update-ref',
      `${DUBSTACK_FETCH_REF_PREFIX}feat/stale`,
      'HEAD',
    ]);

    const deleted = await clearStaleNamespacedFetchRefs(['feat/keep'], dir);

    expect(deleted).toEqual([`${DUBSTACK_FETCH_REF_PREFIX}feat/stale`]);
    const remaining = await listNamespacedFetchRefs(dir);
    expect(remaining).toEqual([`${DUBSTACK_FETCH_REF_PREFIX}feat/keep`]);
  });

  it('returns an empty list when nothing under the namespace exists', async () => {
    const deleted = await clearStaleNamespacedFetchRefs(['anything'], dir);
    expect(deleted).toEqual([]);
  });
});

describe('pruneRemote', () => {
  it('runs against the configured remote without throwing', async () => {
    const remote = await attachBareRemote(dir);
    try {
      await gitInRepo(dir, ['push', 'origin', 'main']);
      await expect(pruneRemote('origin', dir)).resolves.toBeUndefined();
    } finally {
      await remote.cleanup();
    }
  });

  it('throws a DubError when the remote does not exist', async () => {
    await expect(pruneRemote('nope-not-a-remote', dir)).rejects.toThrow(
      DubError,
    );
  });
});
