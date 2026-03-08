import { execa } from 'execa';
import { DubError } from './errors';

export interface DiffStatEntry {
  path: string;
  additions: number;
  deletions: number;
}

/**
 * Checks whether the given directory is inside a git repository.
 * @returns `true` if inside a git worktree, `false` otherwise. Never throws.
 */
export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await execa(
      'git',
      ['rev-parse', '--is-inside-work-tree'],
      { cwd },
    );
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Returns the absolute path to the repository root.
 * @throws {DubError} If not inside a git repository.
 */
export async function getRepoRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await execa('git', ['rev-parse', '--show-toplevel'], {
      cwd,
    });
    return stdout.trim();
  } catch {
    throw new DubError(
      'Not a git repository. Run this command inside a git repo.',
    );
  }
}

/**
 * Returns the name of the currently checked-out branch.
 * @throws {DubError} If HEAD is detached or the repo has no commits.
 */
export async function getCurrentBranch(cwd: string): Promise<string> {
  try {
    const { stdout } = await execa(
      'git',
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      { cwd },
    );
    const branch = stdout.trim();
    if (branch === 'HEAD') {
      throw new DubError(
        'HEAD is detached. Checkout a branch before running this command.',
      );
    }
    return branch;
  } catch (error) {
    if (error instanceof DubError) throw error;
    throw new DubError(
      'Repository has no commits. Make at least one commit first.',
    );
  }
}

/**
 * Checks whether a branch with the given name exists locally.
 * @returns `true` if the branch exists, `false` otherwise. Never throws.
 */
export async function branchExists(
  name: string,
  cwd: string,
): Promise<boolean> {
  try {
    await execa('git', ['rev-parse', '--verify', `refs/heads/${name}`], {
      cwd,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks whether a branch name is valid according to git ref rules.
 * @returns `true` when valid, `false` when invalid. Never throws.
 */
export async function isValidBranchName(
  name: string,
  cwd: string,
): Promise<boolean> {
  try {
    await execa('git', ['check-ref-format', '--branch', name], { cwd });
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates a new branch and switches to it.
 * @throws {DubError} If a branch with that name already exists.
 */
export async function createBranch(name: string, cwd: string): Promise<void> {
  if (await branchExists(name, cwd)) {
    throw new DubError(`Branch '${name}' already exists.`);
  }
  await execa('git', ['checkout', '-b', name], { cwd });
}

/**
 * Switches to an existing branch.
 * @throws {DubError} If the branch does not exist.
 */
export async function checkoutBranch(name: string, cwd: string): Promise<void> {
  try {
    await execa('git', ['checkout', name], { cwd });
  } catch {
    throw new DubError(`Branch '${name}' not found.`);
  }
}

/**
 * Deletes a local branch forcefully. Used by undo to remove created branches.
 * @throws {DubError} If the branch does not exist.
 */
export async function deleteBranch(name: string, cwd: string): Promise<void> {
  try {
    await execa('git', ['branch', '-D', name], { cwd });
  } catch {
    throw new DubError(`Failed to delete branch '${name}'. It may not exist.`);
  }
}

/**
 * Deletes a local branch using safe (`-d`) or force (`-D`) mode.
 */
export async function deleteLocalBranch(
  name: string,
  cwd: string,
  force = false,
): Promise<void> {
  try {
    await execa('git', ['branch', force ? '-D' : '-d', name], { cwd });
  } catch {
    if (force) {
      throw new DubError(
        `Failed to delete branch '${name}'. It may not exist or be checked out.`,
      );
    }
    throw new DubError(
      `Branch '${name}' is not fully merged. Re-run with --force to delete it.`,
    );
  }
}

/**
 * Force-moves a branch pointer to a specific commit SHA.
 * Used by undo to reset branches to their pre-operation tips.
 */
export async function forceBranchTo(
  name: string,
  sha: string,
  cwd: string,
): Promise<void> {
  try {
    const current = await getCurrentBranch(cwd).catch(() => null);
    if (current === name) {
      await execa('git', ['reset', '--hard', sha], { cwd });
    } else {
      await execa('git', ['branch', '-f', name, sha], { cwd });
    }
  } catch (error) {
    if (error instanceof DubError) throw error;
    throw new DubError(`Failed to reset branch '${name}' to ${sha}.`);
  }
}

/**
 * Checks whether the working tree is clean (no uncommitted changes).
 * @returns `true` if clean (no output from `git status --porcelain`).
 */
export async function isWorkingTreeClean(cwd: string): Promise<boolean> {
  const { stdout } = await execa('git', ['status', '--porcelain'], { cwd });
  return stdout.trim() === '';
}

/**
 * Performs `git rebase --onto` to move a branch from one base to another.
 *
 * @param newBase - The commit/branch to rebase onto
 * @param oldBase - The old base commit to replay from
 * @param branch - The branch being rebased
 * @throws {DubError} If a merge conflict occurs during rebase
 */
export async function rebaseOnto(
  newBase: string,
  oldBase: string,
  branch: string,
  cwd: string,
): Promise<void> {
  try {
    await execa('git', ['rebase', '--onto', newBase, oldBase, branch], { cwd });
  } catch {
    throw new DubError(
      `Conflict while restacking '${branch}'.\n` +
        '  Resolve conflicts, stage changes, then run: dub restack --continue',
    );
  }
}

/**
 * Continues an in-progress rebase after conflicts have been resolved.
 * @throws {DubError} If the rebase continue fails.
 */
export async function rebaseContinue(cwd: string): Promise<void> {
  try {
    await execa('git', ['rebase', '--continue'], {
      cwd,
      env: { GIT_EDITOR: 'true' },
    });
  } catch {
    throw new DubError(
      'Failed to continue rebase. Ensure all conflicts are resolved and staged.',
    );
  }
}

/**
 * Aborts an in-progress rebase operation.
 */
export async function rebaseAbort(cwd: string): Promise<void> {
  try {
    await execa('git', ['rebase', '--abort'], { cwd });
  } catch {
    throw new DubError('Failed to abort rebase.');
  }
}

/**
 * Returns the merge-base (common ancestor) commit SHA of two branches.
 */
export async function getMergeBase(
  a: string,
  b: string,
  cwd: string,
): Promise<string> {
  try {
    const { stdout } = await execa('git', ['merge-base', a, b], { cwd });
    return stdout.trim();
  } catch {
    throw new DubError(
      `Could not find common ancestor between '${a}' and '${b}'.`,
    );
  }
}

/**
 * Returns the commit SHA at the tip of a branch.
 * @throws {DubError} If the branch does not exist.
 */
export async function getBranchTip(name: string, cwd: string): Promise<string> {
  try {
    const { stdout } = await execa('git', ['rev-parse', name], { cwd });
    return stdout.trim();
  } catch {
    throw new DubError(`Branch '${name}' not found.`);
  }
}

/**
 * Returns the subject line of the most recent commit on a branch.
 * @throws {DubError} If the branch has no commits.
 */
export async function getLastCommitMessage(
  branch: string,
  cwd: string,
): Promise<string> {
  try {
    const { stdout } = await execa(
      'git',
      ['log', '-1', '--format=%s', branch],
      { cwd },
    );
    const message = stdout.trim();
    if (!message) {
      throw new DubError(`Branch '${branch}' has no commits.`);
    }
    return message;
  } catch (error) {
    if (error instanceof DubError) throw error;
    throw new DubError(`Failed to read commit message for '${branch}'.`);
  }
}

/**
 * Pushes a branch to origin with `--force-with-lease`.
 * @throws {DubError} If the push fails.
 */
export async function pushBranch(branch: string, cwd: string): Promise<void> {
  try {
    await execa('git', ['push', '--force-with-lease', 'origin', branch], {
      cwd,
    });
  } catch {
    throw new DubError(
      `Failed to push '${branch}'. The remote ref may have been updated by someone else.`,
    );
  }
}

/**
 * Stages all changes (tracked, untracked, and deletions).
 * @throws {DubError} If git add fails.
 */
export async function stageAll(cwd: string): Promise<void> {
  try {
    await execa('git', ['add', '-A'], { cwd });
  } catch {
    throw new DubError('Failed to stage changes.');
  }
}

/**
 * Checks whether there are staged changes ready to commit.
 *
 * `git diff --cached --quiet` exits with code 1 when changes exist
 * and code 0 when there are none.
 */
export async function hasStagedChanges(cwd: string): Promise<boolean> {
  try {
    await execa('git', ['diff', '--cached', '--quiet'], { cwd });
    return false;
  } catch (error: unknown) {
    const exitCode = (error as { exitCode?: number }).exitCode;
    if (exitCode === 1) return true;
    throw new DubError('Failed to check staged changes.');
  }
}

/**
 * Commits currently staged changes with the given message.
 * @throws {DubError} If the commit fails (e.g., nothing staged, hook rejection).
 */
export async function commitStaged(
  message: string,
  cwd: string,
): Promise<void> {
  try {
    await execa('git', ['commit', '-m', message], { cwd });
  } catch {
    throw new DubError(
      'Commit failed. Ensure there are staged changes and git hooks pass.',
    );
  }
}

/**
 * Commits currently staged changes using a file-backed message.
 * @throws {DubError} If the commit fails.
 */
export async function commitStagedFromFile(
  filePath: string,
  cwd: string,
): Promise<void> {
  try {
    await execa('git', ['commit', '--file', filePath], { cwd });
  } catch {
    throw new DubError(
      'Commit failed. Ensure there are staged changes and git hooks pass.',
    );
  }
}

/**
 * Commits currently staged changes, opening the editor if no message is provided.
 * @param cwd - The working directory.
 * @param options - Commit options (message, noEdit).
 * @throws {DubError} If the commit fails.
 */
export async function commit(
  cwd: string,
  options?: { message?: string; noEdit?: boolean },
): Promise<void> {
  const args = ['commit'];
  if (options?.message) {
    args.push('-m', options.message);
  }
  if (options?.noEdit) {
    args.push('--no-edit');
  }

  try {
    await execa('git', args, { cwd, stdio: 'inherit' });
  } catch {
    throw new DubError(
      'Commit failed. Ensure there are staged changes and git hooks pass.',
    );
  }
}

/**
 * Amends the previous commit with currently staged changes.
 * @param cwd - The working directory.
 * @param options - Amend options (message, noEdit).
 * @throws {DubError} If the amend fails.
 */
export async function amendCommit(
  cwd: string,
  options?: { message?: string; noEdit?: boolean },
): Promise<void> {
  const args = ['commit', '--amend'];
  if (options?.message) {
    args.push('-m', options.message);
  }
  if (options?.noEdit) {
    args.push('--no-edit');
  }

  try {
    await execa('git', args, { cwd, stdio: 'inherit' });
  } catch (e) {
    throw new DubError(
      `Amend failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Starts an interactive rebase from the given base.
 * Uses stdio: 'inherit' to allow user interaction.
 *
 * @param base - The commit or branch to rebase onto.
 * @param cwd - The working directory.
 * @throws {DubError} If rebase fails.
 */
export async function interactiveRebase(
  base: string,
  cwd: string,
): Promise<void> {
  try {
    await execa('git', ['rebase', '-i', base], { cwd, stdio: 'inherit' });
  } catch {
    throw new DubError('Interactive rebase failed or was cancelled.');
  }
}

/**
 * Starts an interactive staging session (git add -p).
 * Uses stdio: 'inherit' to allow user interaction.
 *
 * @param cwd - The working directory.
 * @throws {DubError} If staging fails.
 */
export async function interactiveStage(cwd: string): Promise<void> {
  try {
    await execa('git', ['add', '-p'], { cwd, stdio: 'inherit' });
  } catch {
    throw new DubError('Interactive staging failed.');
  }
}

/**
 * Stages all modified and deleted files (git add -u).
 *
 * @param cwd - The working directory.
 * @throws {DubError} If staging fails.
 */
export async function stageUpdate(cwd: string): Promise<void> {
  try {
    await execa('git', ['add', '-u'], { cwd });
  } catch {
    throw new DubError('Failed to stage updates.');
  }
}

/**
 * Returns the diff of changes.
 * @param staged - If true, shows staged changes (cached). If false, shows unstaged changes.
 */
export async function getDiff(cwd: string, staged: boolean): Promise<string> {
  try {
    const args = ['diff'];
    if (staged) args.push('--cached');
    const { stdout } = await execa('git', args, { cwd });
    return stdout;
  } catch {
    return '';
  }
}

/**
 * Returns changed file paths for a diff.
 */
export async function getDiffFileNames(
  cwd: string,
  staged: boolean,
): Promise<string[]> {
  try {
    const args = ['diff', '--name-only'];
    if (staged) args.push('--cached');
    const { stdout } = await execa('git', args, { cwd });
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Returns per-file line stats for a diff.
 */
export async function getDiffNumStat(
  cwd: string,
  staged: boolean,
): Promise<DiffStatEntry[]> {
  try {
    const args = ['diff', '--numstat'];
    if (staged) args.push('--cached');
    const { stdout } = await execa('git', args, { cwd });
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [rawAdditions = '0', rawDeletions = '0', path = ''] =
          line.split('\t');
        return {
          path,
          additions: parseDiffCount(rawAdditions),
          deletions: parseDiffCount(rawDeletions),
        };
      })
      .filter((entry) => entry.path.length > 0);
  } catch {
    return [];
  }
}

/**
 * Returns the diff between two refs using merge-base three-dot semantics.
 */
export async function getDiffBetween(
  baseRef: string,
  headRef: string,
  cwd: string,
): Promise<string> {
  try {
    const { stdout } = await execa('git', ['diff', `${baseRef}...${headRef}`], {
      cwd,
    });
    return stdout;
  } catch {
    throw new DubError(
      `Failed to diff '${headRef}' against '${baseRef}'. Verify both refs exist and are reachable.`,
    );
  }
}

function parseDiffCount(raw: string): number {
  if (raw === '-') return 0;
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Returns a list of all local branch names.
 */
export async function listBranches(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execa(
      'git',
      ['branch', '--format=%(refname:short)'],
      { cwd },
    );
    return stdout.trim().split('\n').filter(Boolean);
  } catch {
    throw new DubError('Failed to list branches.');
  }
}

/**
 * Fetches the provided branches from the remote.
 */
export async function fetchBranches(
  branches: string[],
  cwd: string,
  remote = 'origin',
): Promise<void> {
  if (branches.length === 0) return;
  for (const branch of branches) {
    try {
      await execa('git', ['fetch', remote, branch], { cwd });
    } catch (error: unknown) {
      const stderr =
        typeof (error as { stderr?: unknown })?.stderr === 'string'
          ? (error as { stderr: string }).stderr
          : '';
      const stdout =
        typeof (error as { stdout?: unknown })?.stdout === 'string'
          ? (error as { stdout: string }).stdout
          : '';
      const output = `${stderr}\n${stdout}`;
      if (output.includes("couldn't find remote ref")) {
        continue;
      }
      throw new DubError(`Failed to fetch branches from '${remote}'.`);
    }
  }
}

/**
 * Returns whether a remote branch exists.
 */
export async function remoteBranchExists(
  branch: string,
  cwd: string,
  remote = 'origin',
): Promise<boolean> {
  try {
    await execa('git', ['rev-parse', '--verify', `${remote}/${branch}`], {
      cwd,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads a ref SHA.
 */
export async function getRefSha(ref: string, cwd: string): Promise<string> {
  try {
    const { stdout } = await execa('git', ['rev-parse', ref], { cwd });
    return stdout.trim();
  } catch {
    throw new DubError(`Failed to read ref '${ref}'.`);
  }
}

/**
 * Returns true when `ancestor` is an ancestor of `descendant`.
 */
export async function isAncestor(
  ancestor: string,
  descendant: string,
  cwd: string,
): Promise<boolean> {
  try {
    await execa('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      cwd,
    });
    return true;
  } catch (error: unknown) {
    const exitCode = (error as { exitCode?: number }).exitCode;
    if (exitCode === 1) return false;
    throw new DubError(
      `Failed to compare ancestry between '${ancestor}' and '${descendant}'.`,
    );
  }
}

/**
 * Creates or resets a local branch from a remote ref and checks it out.
 */
export async function checkoutRemoteBranch(
  branch: string,
  cwd: string,
  remote = 'origin',
): Promise<void> {
  try {
    await execa('git', ['checkout', '-B', branch, `${remote}/${branch}`], {
      cwd,
    });
  } catch {
    throw new DubError(
      `Failed to create local branch '${branch}' from '${remote}/${branch}'.`,
    );
  }
}

/**
 * Resets a local branch hard to a ref.
 */
export async function hardResetBranchToRef(
  branch: string,
  ref: string,
  cwd: string,
): Promise<void> {
  try {
    const current = await getCurrentBranch(cwd).catch(() => null);
    if (current !== branch) {
      await checkoutBranch(branch, cwd);
    }
    await execa('git', ['reset', '--hard', ref], { cwd });
  } catch {
    throw new DubError(`Failed to hard reset '${branch}' to '${ref}'.`);
  }
}

/**
 * Fast-forwards a local branch to a ref when possible.
 * Returns false when fast-forward is not possible.
 */
export async function fastForwardBranchToRef(
  branch: string,
  ref: string,
  cwd: string,
): Promise<boolean> {
  try {
    const current = await getCurrentBranch(cwd).catch(() => null);
    if (current !== branch) {
      await checkoutBranch(branch, cwd);
    }
    await execa('git', ['merge', '--ff-only', ref], { cwd });
    return true;
  } catch {
    return false;
  }
}

/**
 * Rebases a branch onto a target ref.
 * Returns false if conflicts occur.
 */
export async function rebaseBranchOntoRef(
  branch: string,
  ref: string,
  cwd: string,
): Promise<boolean> {
  try {
    const current = await getCurrentBranch(cwd).catch(() => null);
    if (current !== branch) {
      await checkoutBranch(branch, cwd);
    }
    await execa('git', ['rebase', ref], { cwd });
    return true;
  } catch {
    try {
      await execa('git', ['rebase', '--abort'], { cwd });
    } catch {
      // no-op
    }
    return false;
  }
}
