import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attachBareRemote,
  createTestRepo,
  gitInRepo,
} from '../../test/helpers';
import { branchExists, getCurrentBranch } from '../lib/git';
import * as github from '../lib/github';
import { findStackForBranch, readState } from '../lib/state';
import { readUndoEntry } from '../lib/undo-log';
import { create } from './create';
import { init } from './init';
import { __testing, revert } from './revert';
import { undo } from './undo';

let dir: string;
let cleanup: () => Promise<void>;
let remoteCleanup: (() => Promise<void>) | null = null;

async function commitFile(name: string, content: string): Promise<string> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  await fs.writeFile(path.join(dir, name), content);
  await gitInRepo(dir, ['add', name]);
  await gitInRepo(dir, ['commit', '-m', `feat: ${name}`]);
  const { stdout } = await gitInRepo(dir, ['rev-parse', 'HEAD']);
  return stdout.trim();
}

beforeEach(async () => {
  const repo = await createTestRepo();
  dir = repo.dir;
  cleanup = repo.cleanup;
  await init(dir);
  await gitInRepo(dir, ['add', '.']);
  await gitInRepo(dir, ['commit', '-m', 'init dubstack']);
  // Default mock: skip the gh binary preflight in PR-path tests that opt in.
  vi.spyOn(github, 'ensureGhInstalled').mockResolvedValue();
  vi.spyOn(github, 'checkGhAuth').mockResolvedValue();
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (remoteCleanup) {
    await remoteCleanup();
    remoteCleanup = null;
  }
  await cleanup();
});

describe('revert', () => {
  describe('input validation', () => {
    it('rejects an empty target', async () => {
      await expect(revert(dir, '')).rejects.toThrow(
        'A PR number or commit SHA is required.',
      );
    });

    it('rejects a target that is neither numeric nor a valid SHA shape', async () => {
      await expect(revert(dir, 'feat/branch')).rejects.toThrow(
        "'feat/branch' is not a recognized PR number or commit SHA.",
      );
    });

    it('refuses to run when the working tree is dirty', async () => {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      await fs.writeFile(path.join(dir, 'dirty.txt'), 'wip');
      await expect(revert(dir, 'abc1234')).rejects.toThrow(
        'Working tree has uncommitted changes.',
      );
    });
  });

  describe('SHA path', () => {
    it('creates a revert branch on trunk and tracks it as a new stack root', async () => {
      const sha = await commitFile('feature.txt', 'first change');
      await commitFile('feature2.txt', 'second change'); // advances trunk

      const result = await revert(dir, sha);

      expect(result.prNumber).toBeNull();
      expect(result.trunk).toBe('main');
      expect(result.revertedSha).toBe(sha);
      expect(result.branch).toMatch(/^revert\/commit-[0-9a-f]{7}$/);
      expect(await getCurrentBranch(dir)).toBe(result.branch);

      const log = await gitInRepo(dir, ['log', '-1', '--format=%s']);
      expect(log.stdout.trim()).toMatch(/^Revert "feat: feature.txt"$/);

      const state = await readState(dir);
      const stack = findStackForBranch(state, result.branch);
      expect(stack).toBeDefined();
      const branchEntry = stack?.branches.find((b) => b.name === result.branch);
      expect(branchEntry?.parent).toBe('main');
      const root = stack?.branches.find((b) => b.type === 'root');
      expect(root?.name).toBe('main');
    });

    it('honors -b to override the branch name', async () => {
      const sha = await commitFile('thing.txt', 'change');
      const result = await revert(dir, sha, { branchName: 'revert/custom' });
      expect(result.branch).toBe('revert/custom');
      expect(await branchExists('revert/custom', dir)).toBe(true);
    });

    it('accepts an uppercase SHA and normalizes to the lowercase short form', async () => {
      const sha = await commitFile('upper.txt', 'upper');
      const result = await revert(dir, sha.toUpperCase().slice(0, 8));
      expect(result.revertedSha).toBe(sha);
      expect(result.revertedShortSha).toBe(sha.slice(0, 7));
      expect(result.branch).toBe(`revert/commit-${sha.slice(0, 7)}`);
    });

    it('throws when the SHA cannot be resolved', async () => {
      await expect(revert(dir, 'deadbeef')).rejects.toThrow(
        "Commit 'deadbeef' not found in this repository.",
      );
    });

    it('surfaces an ambiguous-short-SHA error when the prefix matches multiple commits', async () => {
      // Crafting two commits whose short SHAs share a prefix is impractical
      // with random data, so simulate git's error directly via a stubbed
      // execa. The cast through `unknown` is necessary because execa's
      // overload set is broader than our narrow stub signature.
      const exec = await import('../lib/exec');
      type ExecaPassthrough = (
        cmd: unknown,
        args: unknown,
        opts?: unknown,
      ) => unknown;
      const realExeca = exec.execa as unknown as ExecaPassthrough;
      const stub = (cmd: unknown, args: unknown, opts?: unknown): unknown => {
        if (
          cmd === 'git' &&
          Array.isArray(args) &&
          args[0] === 'rev-parse' &&
          args[1] === '--verify' &&
          typeof args[2] === 'string' &&
          args[2].includes('^{commit}')
        ) {
          return Promise.reject(
            Object.assign(new Error('git rev-parse exited 128'), {
              stderr:
                "fatal: ambiguous argument 'abc1234^{commit}': short SHA1 abc1234 is ambiguous",
              exitCode: 128,
            }),
          );
        }
        return realExeca(cmd, args, opts);
      };
      const spy = vi
        .spyOn(exec, 'execa')
        .mockImplementation(stub as unknown as typeof exec.execa);

      try {
        await expect(revert(dir, 'abc1234')).rejects.toThrow(
          /is an ambiguous short SHA/,
        );
      } finally {
        spy.mockRestore();
      }
    });

    it('writes an undo entry that deletes the revert branch', async () => {
      const sha = await commitFile('a.txt', 'a');
      const result = await revert(dir, sha);

      const entry = await readUndoEntry(dir);
      expect(entry.operation).toBe('create');
      expect(entry.createdBranches).toEqual([result.branch]);

      const undone = await undo(dir);
      expect(undone.undone).toBe('create');
      expect(await branchExists(result.branch, dir)).toBe(false);
      const state = await readState(dir);
      expect(findStackForBranch(state, result.branch)).toBeUndefined();
    });

    it('rejects a branch name that collides with an existing branch', async () => {
      const sha = await commitFile('x.txt', 'x');
      await create('revert/custom', dir);
      await gitInRepo(dir, ['checkout', 'main']);

      await expect(
        revert(dir, sha, { branchName: 'revert/custom' }),
      ).rejects.toThrow(/already (exists|tracked)/);
    });

    it('clears the undo entry when git revert fails', async () => {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      await fs.writeFile(path.join(dir, 'shared.txt'), 'first\n');
      await gitInRepo(dir, ['add', 'shared.txt']);
      await gitInRepo(dir, ['commit', '-m', 'feat: shared first']);
      const { stdout: firstSha } = await gitInRepo(dir, ['rev-parse', 'HEAD']);
      const targetSha = firstSha.trim();

      await fs.writeFile(path.join(dir, 'shared.txt'), 'second\n');
      await gitInRepo(dir, ['add', 'shared.txt']);
      await gitInRepo(dir, ['commit', '-m', 'feat: shared second']);

      await expect(revert(dir, targetSha)).rejects.toThrow();
      await expect(readUndoEntry(dir)).rejects.toThrow('Nothing to undo.');
    });

    it('rolls back to the previous branch when git revert fails', async () => {
      // Commit two changes to the same file so a revert of the first
      // produces a conflict against the second commit's content.
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      await fs.writeFile(path.join(dir, 'shared.txt'), 'first\n');
      await gitInRepo(dir, ['add', 'shared.txt']);
      await gitInRepo(dir, ['commit', '-m', 'feat: shared first']);
      const { stdout: firstSha } = await gitInRepo(dir, ['rev-parse', 'HEAD']);
      const targetSha = firstSha.trim();

      await fs.writeFile(path.join(dir, 'shared.txt'), 'second\n');
      await gitInRepo(dir, ['add', 'shared.txt']);
      await gitInRepo(dir, ['commit', '-m', 'feat: shared second']);

      await expect(revert(dir, targetSha)).rejects.toThrow(/Failed to revert/);

      // Should be left back on main with no leaked branch.
      expect(await getCurrentBranch(dir)).toBe('main');
      expect(
        await branchExists(`revert/commit-${targetSha.slice(0, 7)}`, dir),
      ).toBe(false);
    });
  });

  describe('PR path', () => {
    it('resolves a merged PR to its merge commit and creates a revert branch', async () => {
      const sha = await commitFile('api.txt', 'api change');
      vi.spyOn(github, 'getPrMergeInfoByNumber').mockResolvedValue({
        number: 42,
        state: 'MERGED',
        mergeCommitSha: sha,
        headRefName: 'feature/api',
      });

      const result = await revert(dir, '42');

      expect(result.prNumber).toBe(42);
      expect(result.revertedSha).toBe(sha);
      expect(result.sourceLabel).toBe('api');
      expect(result.branch).toBe(`revert/api-${sha.slice(0, 7)}`);
    });

    it('accepts a "#"-prefixed PR number', async () => {
      const sha = await commitFile('y.txt', 'y');
      vi.spyOn(github, 'getPrMergeInfoByNumber').mockResolvedValue({
        number: 7,
        state: 'MERGED',
        mergeCommitSha: sha,
        headRefName: 'feature/y',
      });

      const result = await revert(dir, '#7');
      expect(result.prNumber).toBe(7);
    });

    it('errors clearly when the PR is open', async () => {
      vi.spyOn(github, 'getPrMergeInfoByNumber').mockResolvedValue({
        number: 99,
        state: 'OPEN',
        mergeCommitSha: null,
        headRefName: 'feature/wip',
      });

      await expect(revert(dir, '99')).rejects.toThrow(
        'PR #99 is open, not merged',
      );
    });

    it('errors clearly when the PR cannot be found', async () => {
      vi.spyOn(github, 'getPrMergeInfoByNumber').mockResolvedValue(null);

      await expect(revert(dir, '1234')).rejects.toThrow(
        'PR #1234 was not found.',
      );
    });

    it('errors when a merged PR has no merge commit metadata', async () => {
      vi.spyOn(github, 'getPrMergeInfoByNumber').mockResolvedValue({
        number: 5,
        state: 'MERGED',
        mergeCommitSha: null,
        headRefName: 'feature/x',
      });

      await expect(revert(dir, '5')).rejects.toThrow(
        'has no merge commit on file',
      );
    });
  });

  describe('--submit', () => {
    it('pushes the revert branch and reports the submit result', async () => {
      const remote = await attachBareRemote(dir);
      remoteCleanup = remote.cleanup;
      // Make sure trunk exists on the remote so origin/main resolves.
      await gitInRepo(dir, ['push', 'origin', 'main']);

      const sha = await commitFile('s.txt', 's');
      // Push trunk again so the revert branches off the latest pushed tip.
      await gitInRepo(dir, ['push', 'origin', 'main']);

      // Stub gh calls inside submit so this test stays hermetic.
      vi.spyOn(github, 'getPr').mockResolvedValue(null);
      const createPrSpy = vi.spyOn(github, 'createPr').mockResolvedValue({
        number: 321,
        url: 'https://github.com/x/y/pull/321',
        title: 'Revert',
        body: '',
      });
      vi.spyOn(github, 'updatePrBody').mockResolvedValue();

      const result = await revert(dir, sha, { submit: true });

      expect(result.submitResult).not.toBeNull();
      expect(result.submitResult?.pushed).toContain(result.branch);
      expect(createPrSpy).toHaveBeenCalledOnce();
    });

    it('preserves the revert branch and surfaces a wrapped error when submit fails', async () => {
      const remote = await attachBareRemote(dir);
      remoteCleanup = remote.cleanup;
      await gitInRepo(dir, ['push', 'origin', 'main']);

      const sha = await commitFile('s2.txt', 's2');
      await gitInRepo(dir, ['push', 'origin', 'main']);

      // Fail the submit by making ensureGhInstalled throw.
      vi.spyOn(github, 'ensureGhInstalled').mockRejectedValueOnce(
        Object.assign(new Error('gh missing'), { name: 'DubError' }),
      );

      await expect(revert(dir, sha, { submit: true })).rejects.toThrow(
        /was created but 'dub submit' failed/,
      );
      // The revert branch should still exist locally and in state.
      expect(await branchExists(`revert/commit-${sha.slice(0, 7)}`, dir)).toBe(
        true,
      );
      const state = await readState(dir);
      expect(
        findStackForBranch(state, `revert/commit-${sha.slice(0, 7)}`),
      ).toBeDefined();
    });
  });
});

describe('revert helpers', () => {
  it('strips the path off PR head refs when building the branch name', () => {
    expect(__testing.leafBranchName('feature/auth/login')).toBe('login');
    expect(__testing.leafBranchName('feature')).toBe('feature');
    expect(__testing.leafBranchName(null)).toBeNull();
    expect(__testing.leafBranchName('   ')).toBeNull();
  });

  it('sanitizes branch segments to safe characters', () => {
    expect(__testing.sanitizeBranchSegment('hello world!')).toBe('hello-world');
    expect(__testing.sanitizeBranchSegment('---weird---')).toBe('weird');
    expect(__testing.sanitizeBranchSegment('a__b')).toBe('a__b');
  });

  it('builds a revert branch name from source + short SHA', () => {
    expect(__testing.buildRevertBranchName('feature', 'abc1234')).toBe(
      'revert/feature-abc1234',
    );
    expect(__testing.buildRevertBranchName('', 'abc1234')).toBe(
      'revert/commit-abc1234',
    );
  });
});
