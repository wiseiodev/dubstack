import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execa } from 'execa';

const GIT_TEST_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Test User',
  GIT_AUTHOR_EMAIL: 'test@dubstack.test',
  GIT_COMMITTER_NAME: 'Test User',
  GIT_COMMITTER_EMAIL: 'test@dubstack.test',
};

/**
 * Creates an isolated git repository in a temporary directory for testing.
 *
 * Uses isolated git config (`GIT_CONFIG_GLOBAL=/dev/null`) to prevent
 * the host environment from leaking into tests (hooks, user config, etc.).
 * Makes an initial empty commit so `git checkout -b` works.
 *
 * @returns Object with the temp directory path and a cleanup function.
 */
export async function createTestRepo(): Promise<{
  dir: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'dubstack-test-'),
  );

  await execa('git', ['init', '-b', 'main'], { cwd: dir, env: GIT_TEST_ENV });
  await execa('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  await execa('git', ['config', 'user.email', 'test@dubstack.test'], {
    cwd: dir,
  });
  await execa('git', ['commit', '--allow-empty', '-m', 'init'], {
    cwd: dir,
    env: GIT_TEST_ENV,
  });

  return {
    dir,
    cleanup: async () => {
      await fs.promises.rm(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Runs a git command in the test repo with isolated environment.
 * Convenience wrapper for tests that need to set up branches/commits.
 */
export async function gitInRepo(
  dir: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return execa('git', args, { cwd: dir, env: GIT_TEST_ENV });
}

/**
 * Creates an isolated bare repository to use as a remote for the given
 * local repo. Configures it as `origin`. Returns the bare-repo path and a
 * cleanup function.
 */
export async function attachBareRemote(localDir: string): Promise<{
  remoteDir: string;
  cleanup: () => Promise<void>;
}> {
  const remoteDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'dubstack-test-remote-'),
  );
  await execa('git', ['init', '-b', 'main', '--bare'], {
    cwd: remoteDir,
    env: GIT_TEST_ENV,
  });
  await execa('git', ['remote', 'add', 'origin', remoteDir], {
    cwd: localDir,
    env: GIT_TEST_ENV,
  });
  return {
    remoteDir,
    cleanup: async () => {
      await fs.promises.rm(remoteDir, { recursive: true, force: true });
    },
  };
}

export async function withBranchWorktree<T>(
  dir: string,
  branch: string,
  run: (worktreeDir: string) => Promise<T>,
): Promise<T> {
  const safeBranch = branch.replace(/[^a-zA-Z0-9_-]+/g, '-');
  const worktreeDir = `${dir}-${safeBranch}-worktree`;

  await gitInRepo(dir, ['worktree', 'add', '--force', worktreeDir, branch]);
  try {
    return await run(await fs.promises.realpath(worktreeDir));
  } finally {
    await gitInRepo(dir, ['worktree', 'remove', '--force', worktreeDir]).catch(
      () => undefined,
    );
    await fs.promises.rm(worktreeDir, { recursive: true, force: true });
  }
}
