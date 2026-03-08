import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestRepo, gitInRepo } from '../../test/helpers';
import { DubError } from './errors';
import {
  branchExists,
  commitStaged,
  commitStagedFromFile,
  createBranch,
  deleteBranch,
  forceBranchTo,
  getBranchTip,
  getCurrentBranch,
  getDiffBetween,
  getMergeBase,
  hasStagedChanges,
  hasUniquePatchCommits,
  isGitRepo,
  isValidBranchName,
  isWorkingTreeClean,
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
