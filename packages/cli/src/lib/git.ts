import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { DubError } from './errors';
import { execa } from './exec';
import { retry } from './retry';

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
    throw new DubError('Not a git repository.', [
      "Run 'git init' in the desired project directory.",
      "Run 'cd <repo>' to switch into an existing git repository and retry.",
    ]);
  }
}

/**
 * Returns local branches checked out in other git worktrees.
 */
export async function listWorktreeCheckouts(
  cwd: string,
): Promise<Map<string, string>> {
  const repoRoot = await realpathOrResolve(await getRepoRoot(cwd));
  const { stdout } = await execa('git', ['worktree', 'list', '--porcelain'], {
    cwd,
  });
  const checkouts = new Map<string, string>();
  let worktreePath: string | null = null;

  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      worktreePath = line.slice('worktree '.length);
      continue;
    }

    if (!line.startsWith('branch refs/heads/') || !worktreePath) continue;

    const checkoutRoot = await realpathOrResolve(worktreePath);
    if (checkoutRoot === repoRoot) continue;

    const branch = line.slice('branch refs/heads/'.length);
    checkouts.set(branch, worktreePath);
  }

  return checkouts;
}

async function realpathOrResolve(inputPath: string): Promise<string> {
  try {
    return await fs.realpath(inputPath);
  } catch {
    return path.resolve(inputPath);
  }
}

export function formatWorktreeCheckoutSkipMessage(
  branch: string,
  worktreePath: string,
  command = 'dub sync',
): string {
  return `ℹ Skipped '${branch}' — checked out in ${worktreePath}.\n   Run \`${command}\` from that worktree to update it.`;
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
      throw new DubError('HEAD is detached.', [
        "Run 'git checkout <branch>' to attach HEAD to a branch.",
        "Run 'dub checkout' to pick a tracked branch interactively.",
      ]);
    }
    return branch;
  } catch (error) {
    if (error instanceof DubError) throw error;
    throw new DubError('Repository has no commits.', [
      'Make at least one commit (e.g. \'git commit --allow-empty -m "init"\').',
      "Rerun 'dub init' after committing if you have not yet initialized.",
    ]);
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
    throw new DubError(`Branch '${name}' already exists.`, [
      `Run 'dub checkout ${name}' to switch to the existing branch.`,
      'Pick a different branch name and retry.',
      `Run 'dub delete ${name}' to remove the existing branch first.`,
    ]);
  }
  await execa('git', ['checkout', '-b', name], { cwd });
}

/**
 * Switches to an existing branch.
 * @throws {DubError} If the branch does not exist, or if checkout fails for
 * any other git error (for example, dirty working tree or ref lock failures).
 */
export async function checkoutBranch(name: string, cwd: string): Promise<void> {
  try {
    await execa('git', ['checkout', name], { cwd });
  } catch (error) {
    const details = readGitCommandOutput(error);
    if (isMissingBranchCheckoutError(details, name)) {
      throw new DubError(`Branch '${name}' not found.`, [
        "Run 'dub log' to see tracked branches.",
        `Run 'git fetch && git checkout ${name}' if the branch only exists on the remote.`,
      ]);
    }

    throw new DubError(
      formatGitFailure(`Failed to checkout branch '${name}'.`, details),
      [
        "Run 'git status' to inspect uncommitted changes blocking checkout.",
        "Run 'git stash' to set aside local changes, then retry the checkout.",
      ],
    );
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
    throw new DubError(`Failed to delete branch '${name}'.`, [
      `Run 'git branch --list ${name}' to confirm the branch exists.`,
      `Run 'git branch -D ${name}' manually to inspect the underlying error.`,
    ]);
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
      throw new DubError(`Failed to delete branch '${name}'.`, [
        `Run 'git branch --list ${name}' to confirm the branch exists.`,
        `Run 'git checkout <other>' to switch off '${name}' if it is currently checked out.`,
      ]);
    }
    throw new DubError(`Branch '${name}' is not fully merged.`, [
      `Run 'dub delete ${name} --force' to delete it anyway.`,
      `Run 'dub log' to confirm whether '${name}' has unmerged work.`,
    ]);
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
    throw new DubError(`Failed to reset branch '${name}' to ${sha}.`, [
      "Run 'git status' to inspect the working tree.",
      `Run 'git branch -f ${name} ${sha}' manually to inspect the underlying error.`,
    ]);
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
    throw new DubError(`Conflict while restacking '${branch}'.`, [
      'Resolve conflicts and stage the resolved files.',
      "Run 'dub continue --ai' to let DubStack try the resolution.",
      "Run 'dub continue' (or 'dub restack --continue') after resolving manually.",
      "Run 'dub abort' to cancel and roll back progress.",
    ]);
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
    throw new DubError('Failed to continue rebase.', [
      "Run 'git status' to see remaining unmerged paths.",
      "Run 'git add <file>' for each resolved file, then rerun 'dub continue'.",
      "Run 'dub abort' to cancel the rebase if it can't be continued.",
    ]);
  }
}

/**
 * Aborts an in-progress rebase operation.
 */
export async function rebaseAbort(cwd: string): Promise<void> {
  try {
    await execa('git', ['rebase', '--abort'], { cwd });
  } catch {
    throw new DubError('Failed to abort rebase.', [
      "Run 'git rebase --abort' manually to inspect the underlying error.",
      "Run 'git status' to confirm whether a rebase is actually in progress.",
    ]);
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
      [
        `Run 'git log --oneline ${a}' to confirm the branch has commits.`,
        `Run 'git fetch origin' to fetch missing history, then retry.`,
      ],
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
    throw new DubError(`Branch '${name}' not found.`, [
      "Run 'dub log' to see tracked branches.",
      `Run 'git fetch && git checkout ${name}' if the branch only exists on the remote.`,
    ]);
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
      throw new DubError(`Branch '${branch}' has no commits.`, [
        `Run 'git log ${branch}' to confirm the branch has commits.`,
        'Make at least one commit on the branch before retrying.',
      ]);
    }
    return message;
  } catch (error) {
    if (error instanceof DubError) throw error;
    throw new DubError(`Failed to read commit message for '${branch}'.`, [
      `Run 'git log -1 ${branch}' manually to inspect the underlying error.`,
    ]);
  }
}

/**
 * Returns the local ref path used to track the last SHA we successfully
 * pushed to `origin/<branch>`. We maintain this ourselves rather than
 * trusting `refs/remotes/origin/<branch>`, which can be silently updated
 * by background fetches (IDEs, watchers) and defeat `--force-with-lease`.
 */
export function lastPushedRef(branch: string): string {
  return `refs/dubstack/last-pushed/${branch}`;
}

/**
 * Reads our locally-tracked last-pushed SHA for a branch, or null if we
 * have never recorded one.
 *
 * `git rev-parse --verify --quiet` exits 1 when the ref is missing (the
 * expected "no tracked SHA yet" case). Any other exit code signals a
 * real failure (not a repo, lock contention, etc.) — we surface those as
 * `DubError` so we don't silently degrade `pushBranch` to a bare lease.
 *
 * @throws {DubError} If git rev-parse fails for any reason other than
 * the ref being missing.
 */
export async function readLastPushedSha(
  branch: string,
  cwd: string,
): Promise<string | null> {
  try {
    const { stdout } = await execa(
      'git',
      ['rev-parse', '--verify', '--quiet', lastPushedRef(branch)],
      { cwd },
    );
    const sha = stdout.trim();
    return sha || null;
  } catch (error) {
    const exitCode = (error as { exitCode?: number }).exitCode;
    if (exitCode === 1) return null;
    throw new DubError(
      formatGitFailure(
        `Failed to read last-pushed ref for '${branch}'.`,
        readGitCommandOutput(error),
      ),
      [
        `Run 'git rev-parse --verify ${lastPushedRef(branch)}' manually to inspect the underlying error.`,
        `Run 'git status' to confirm the repository is in a healthy state.`,
      ],
    );
  }
}

/**
 * Writes our locally-tracked last-pushed SHA for a branch. Only `dub submit`
 * and `dub sync` should update this ref; never background processes.
 * @throws {DubError} If the ref update fails.
 */
export async function writeLastPushedSha(
  branch: string,
  sha: string,
  cwd: string,
): Promise<void> {
  try {
    await execa('git', ['update-ref', lastPushedRef(branch), sha], { cwd });
  } catch (error) {
    throw new DubError(
      formatGitFailure(
        `Failed to record last-pushed SHA for '${branch}'.`,
        readGitCommandOutput(error),
      ),
      [
        `Run 'git update-ref ${lastPushedRef(branch)} ${sha}' manually to inspect the underlying error.`,
        `Run 'dub sync' to reconcile state before the next push.`,
      ],
    );
  }
}

/**
 * Options accepted by {@link pushBranch}.
 */
export interface PushBranchOptions {
  /**
   * Invoked before each retry attempt with the upcoming attempt number
   * (1-indexed) and the last error. Wired by callers to emit verbose
   * log lines (e.g. under `--verbose`).
   */
  onRetry?: (attempt: number, err: unknown) => void;
}

/**
 * Pushes a branch to origin with `--force-with-lease`, scoped to our
 * locally-tracked last-pushed SHA (`refs/dubstack/last-pushed/<branch>`).
 *
 * Using the tracked ref instead of git's default lease target avoids the
 * race where a background fetch updates `refs/remotes/origin/<branch>`
 * and silently makes the lease succeed against stale-on-disk state, which
 * would let us overwrite work pushed by a teammate.
 *
 * The push itself is wrapped in {@link retry} (up to 4 attempts) so
 * transient network blips don't abort long sync runs. Authentication
 * failures, missing repositories, refusal to delete the current branch,
 * and lease rejection short-circuit immediately. Lease rejection surfaces
 * as a `DubError` whose recovery hint points at `dub sync`.
 *
 * On success, updates the tracked ref to the freshly-pushed SHA.
 *
 * On a first push (no tracked SHA recorded yet), falls back to bare
 * `--force-with-lease`. Race protection kicks in for all subsequent pushes
 * once the tracking ref is established.
 *
 * @throws {DubError} If the push fails (permanently or after exhausting retries).
 */
export async function pushBranch(
  branch: string,
  cwd: string,
  options: PushBranchOptions = {},
): Promise<void> {
  const trackedSha = await readLastPushedSha(branch, cwd);
  const leaseArg = trackedSha
    ? `--force-with-lease=refs/heads/${branch}:${trackedSha}`
    : '--force-with-lease';

  try {
    await retry(
      () => execa('git', ['push', leaseArg, 'origin', branch], { cwd }),
      {
        isPermanent: isPushPermanentError,
        onRetry: options.onRetry,
      },
    );
  } catch (error) {
    const details = readGitErrorOutput(error);
    if (isLeaseRejectionError(details)) {
      throw new DubError(
        formatGitFailure(
          `Push of '${branch}' refused: remote has updates not reflected in our last-pushed ref.`,
          details,
        ),
        [
          `Run 'dub sync' to reconcile remote updates, then retry 'dub submit'.`,
          `Run 'git fetch origin ${branch}' and inspect 'origin/${branch}' to see the third-party changes.`,
        ],
      );
    }
    throw new DubError(
      formatGitFailure(`Failed to push '${branch}'.`, details),
      [
        `Run 'dub sync' to reconcile remote updates, then retry the push.`,
        `Run 'git push --force-with-lease origin ${branch}' manually to see the underlying error.`,
      ],
    );
  }

  const newSha = await getBranchTip(branch, cwd);
  await writeLastPushedSha(branch, newSha, cwd);
}

function isLeaseRejectionError(output: string): boolean {
  return output.toLowerCase().includes('stale info');
}

/**
 * Stages all changes (tracked, untracked, and deletions).
 * @throws {DubError} If git add fails.
 */
export async function stageAll(cwd: string): Promise<void> {
  try {
    await execa('git', ['add', '-A'], { cwd });
  } catch {
    throw new DubError('Failed to stage changes.', [
      "Run 'git add -A' manually to inspect the underlying error.",
      "Run 'git status' to verify the working tree state.",
    ]);
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
    throw new DubError('Failed to check staged changes.', [
      "Run 'git diff --cached' manually to inspect the underlying error.",
    ]);
  }
}

/**
 * Checks whether there are unstaged changes in the working tree (modifications
 * to tracked files that are not in the index). Untracked files don't count.
 *
 * Differs from {@link isWorkingTreeClean} which also flags staged changes — use
 * this when you need to know whether the index and working tree diverge, not
 * whether the tree differs from HEAD.
 */
export async function hasUnstagedChanges(cwd: string): Promise<boolean> {
  try {
    await execa('git', ['diff', '--quiet'], { cwd });
    return false;
  } catch (error: unknown) {
    const exitCode = (error as { exitCode?: number }).exitCode;
    if (exitCode === 1) return true;
    throw new DubError('Failed to check unstaged changes.', [
      "Run 'git diff' manually to inspect the underlying error.",
    ]);
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
    throw new DubError('Commit failed.', [
      "Run 'git status' to confirm there are staged changes.",
      "Run 'git commit' manually to see pre-commit hook output.",
      "Run 'git add <files>' to stage missing changes, then retry.",
    ]);
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
    throw new DubError('Commit failed.', [
      "Run 'git status' to confirm there are staged changes.",
      "Run 'git commit' manually to see pre-commit hook output.",
      "Run 'git add <files>' to stage missing changes, then retry.",
    ]);
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
    throw new DubError('Commit failed.', [
      "Run 'git status' to confirm there are staged changes.",
      "Run 'git commit' manually to see pre-commit hook output.",
      "Run 'git add <files>' to stage missing changes, then retry.",
    ]);
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
      [
        "Run 'git commit --amend' manually to see pre-commit hook output.",
        "Run 'git status' to confirm whether there are staged changes to amend.",
      ],
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
    throw new DubError('Interactive rebase failed or was cancelled.', [
      "Run 'git status' to confirm whether a rebase is still in progress.",
      "Run 'dub abort' if you no longer want to keep the rebase.",
    ]);
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
    throw new DubError('Interactive staging failed.', [
      "Run 'git add -p' manually to inspect the underlying error.",
    ]);
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
    throw new DubError('Failed to stage updates.', [
      "Run 'git add -u' manually to inspect the underlying error.",
    ]);
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
    throw new DubError(`Failed to diff '${headRef}' against '${baseRef}'.`, [
      `Run 'git rev-parse ${baseRef}' and 'git rev-parse ${headRef}' to confirm both refs exist.`,
      `Run 'git fetch origin' to fetch missing history, then retry.`,
    ]);
  }
}

/**
 * Returns whether a branch has unique patch content not already present upstream.
 *
 * Uses `git cherry`, which marks patch-equivalent commits with `-` and unique
 * commits with `+`.
 *
 * Guard against the Graphite v1.7.18 range-diff bug class: empty output is
 * NEVER trusted as "equivalent" on its own. When `git cherry` emits nothing,
 * confirm equivalence with a positive signal (SHA equality or
 * `headRef`-reachable-from-`baseRef`) before reporting no unique commits.
 * Without that confirmation we fail open ("has unique") so a malformed cherry
 * result cannot silently mask local work and cause sync to discard it.
 */
export async function hasUniquePatchCommits(
  baseRef: string,
  headRef: string,
  cwd: string,
): Promise<boolean> {
  let stdout: string;
  try {
    ({ stdout } = await execa('git', ['cherry', baseRef, headRef], { cwd }));
  } catch {
    throw new DubError(
      `Failed to compare patch-equivalent commits for '${headRef}' against '${baseRef}'.`,
      [
        `Run 'git cherry ${baseRef} ${headRef}' manually to inspect the underlying error.`,
        `Run 'git fetch origin' to fetch missing history, then retry.`,
      ],
    );
  }

  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return !(await isPatchEquivalenceConfirmed(baseRef, headRef, cwd));
  }

  return lines.some((line) => line.startsWith('+'));
}

async function isPatchEquivalenceConfirmed(
  baseRef: string,
  headRef: string,
  cwd: string,
): Promise<boolean> {
  try {
    const [baseSha, headSha] = await Promise.all([
      getRefSha(baseRef, cwd),
      getRefSha(headRef, cwd),
    ]);
    if (baseSha === headSha) return true;
    return await isAncestor(headRef, baseRef, cwd);
  } catch {
    return false;
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
    throw new DubError('Failed to list branches.', [
      "Run 'git branch' manually to inspect the underlying error.",
    ]);
  }
}

/**
 * Git ref namespace where DubStack writes fetched branch tips so that
 * user-managed `FETCH_HEAD` is never clobbered by sync operations.
 */
export const DUBSTACK_FETCH_REF_PREFIX = 'refs/dubstack/fetch-head/';

/**
 * Returns the namespaced fetch ref for the given branch.
 */
export function namespacedFetchRef(branch: string): string {
  return `${DUBSTACK_FETCH_REF_PREFIX}${branch}`;
}

/**
 * Options accepted by {@link fetchBranches}.
 */
export interface FetchBranchesOptions {
  /**
   * Invoked before each retry attempt with the upcoming attempt number
   * (1-indexed) and the last error. Wired by callers to emit verbose
   * log lines (e.g. under `--verbose`).
   */
  onRetry?: (attempt: number, err: unknown) => void;
  /**
   * Invoked before each per-branch fetch with the 1-indexed position and the
   * branch name. Used by callers to drive a progress bar with the current
   * branch as detail text.
   */
  onBranchStart?: (index: number, branch: string) => void;
}

/**
 * Fetches the provided branches from the remote into a namespaced ref
 * (`refs/dubstack/fetch-head/<branch>`) so that the user's own `FETCH_HEAD`
 * is left untouched. Also passes `--no-tags` to cut network cost on repos
 * with many release tags. Each per-branch fetch is wrapped in {@link retry}
 * (up to 4 attempts) so transient network blips during long sync runs no
 * longer abort the whole operation. Authentication failures and missing
 * repositories short-circuit without retrying.
 */
export async function fetchBranches(
  branches: string[],
  cwd: string,
  remote = 'origin',
  options: FetchBranchesOptions = {},
): Promise<void> {
  if (branches.length === 0) return;
  let index = 0;
  for (const branch of branches) {
    index += 1;
    options.onBranchStart?.(index, branch);
    const refspec = `${branch}:${namespacedFetchRef(branch)}`;
    try {
      await retry(
        () =>
          execa(
            'git',
            [
              'fetch',
              '--no-write-fetch-head',
              '--no-tags',
              '-f',
              remote,
              refspec,
            ],
            { cwd },
          ),
        {
          isPermanent: isFetchPermanentError,
          onRetry: options.onRetry,
        },
      );
    } catch (error: unknown) {
      const output = readGitErrorOutput(error);
      if (output.includes("couldn't find remote ref")) {
        continue;
      }
      throw new DubError(`Failed to fetch branches from '${remote}'.`, [
        `Run 'git fetch ${remote}' manually to inspect the underlying error.`,
        `Run 'git remote -v' to verify '${remote}' is configured correctly.`,
      ]);
    }
  }
}

/**
 * Lists every ref under `refs/dubstack/fetch-head/`.
 * Returns full ref names (e.g. `refs/dubstack/fetch-head/feat/a`).
 */
export async function listNamespacedFetchRefs(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execa(
      'git',
      ['for-each-ref', '--format=%(refname)', DUBSTACK_FETCH_REF_PREFIX],
      { cwd },
    );
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Deletes a single git ref. Silently no-ops if the ref does not exist.
 */
export async function deleteRef(ref: string, cwd: string): Promise<void> {
  try {
    await execa('git', ['update-ref', '-d', ref], { cwd });
  } catch {
    // ref may already be gone; nothing to do.
  }
}

/**
 * Walks `refs/dubstack/fetch-head/*` and deletes any ref whose source branch
 * is not in `keepBranches`. Returns the deleted ref names.
 */
export async function clearStaleNamespacedFetchRefs(
  keepBranches: Iterable<string>,
  cwd: string,
): Promise<string[]> {
  const keep = new Set(keepBranches);
  const refs = await listNamespacedFetchRefs(cwd);
  const deleted: string[] = [];
  for (const ref of refs) {
    const branch = ref.slice(DUBSTACK_FETCH_REF_PREFIX.length);
    if (!keep.has(branch)) {
      await deleteRef(ref, cwd);
      deleted.push(ref);
    }
  }
  return deleted;
}

/**
 * Runs `git remote prune <remote>` to clear deleted-remote-branch ghost refs.
 */
export async function pruneRemote(remote: string, cwd: string): Promise<void> {
  try {
    await execa('git', ['remote', 'prune', remote], { cwd });
  } catch {
    throw new DubError(`Failed to prune remote '${remote}'.`, [
      `Run 'git remote prune ${remote}' manually to inspect the underlying error.`,
      `Run 'git remote -v' to verify '${remote}' is configured correctly.`,
    ]);
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
    throw new DubError(`Failed to read ref '${ref}'.`, [
      `Run 'git rev-parse ${ref}' manually to confirm the ref exists.`,
      `Run 'git fetch origin' to fetch missing remote refs, then retry.`,
    ]);
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
      [
        `Run 'git rev-parse ${ancestor}' and 'git rev-parse ${descendant}' to confirm both refs exist.`,
        `Run 'git fetch origin' to fetch missing history, then retry.`,
      ],
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
      [
        `Run 'git fetch ${remote} ${branch}' to refresh the remote ref.`,
        `Run 'git checkout -B ${branch} ${remote}/${branch}' manually to inspect the error.`,
      ],
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
  } catch (error) {
    throw new DubError(
      formatGitFailure(
        `Failed to hard reset '${branch}' to '${ref}'.`,
        readGitCommandOutput(error),
      ),
      [
        "Run 'git status' to inspect uncommitted changes blocking the reset.",
        "Run 'git stash' to set aside local changes, then retry.",
      ],
    );
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
  } catch (error) {
    const details = readGitCommandOutput(error);
    if (isFastForwardConflictError(details)) {
      return false;
    }
    throw new DubError(
      formatGitFailure(
        `Failed to fast-forward '${branch}' to '${ref}'.`,
        details,
      ),
    );
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

const AUTH_FAILURE_PATTERN = /fatal:\s*authentication failed/i;
const REPO_NOT_FOUND_PATTERN = /repository not found/i;
const REFUSE_DELETE_CURRENT_PATTERN = /refusing to delete the current branch/i;

function readGitErrorOutput(error: unknown): string {
  const direct = readGitCommandOutput(error);
  const cause = (error as { cause?: unknown })?.cause;
  if (!cause) return direct;
  const causeOutput = readGitCommandOutput(cause);
  if (!causeOutput) return direct;
  if (!direct) return causeOutput;
  return `${direct}\n${causeOutput}`;
}

function isFetchPermanentError(error: unknown): boolean {
  const output = readGitCommandOutput(error);
  return (
    AUTH_FAILURE_PATTERN.test(output) ||
    REPO_NOT_FOUND_PATTERN.test(output) ||
    output.includes("couldn't find remote ref")
  );
}

function isPushPermanentError(error: unknown): boolean {
  const output = readGitCommandOutput(error);
  return (
    AUTH_FAILURE_PATTERN.test(output) ||
    REPO_NOT_FOUND_PATTERN.test(output) ||
    REFUSE_DELETE_CURRENT_PATTERN.test(output) ||
    isLeaseRejectionError(output)
  );
}

function readGitCommandOutput(error: unknown): string {
  const stderr =
    typeof (error as { stderr?: unknown })?.stderr === 'string'
      ? (error as { stderr: string }).stderr
      : '';
  const stdout =
    typeof (error as { stdout?: unknown })?.stdout === 'string'
      ? (error as { stdout: string }).stdout
      : '';
  const shortMessage =
    typeof (error as { shortMessage?: unknown })?.shortMessage === 'string'
      ? (error as { shortMessage: string }).shortMessage
      : '';
  const message =
    error instanceof Error && typeof error.message === 'string'
      ? error.message
      : '';

  return [stderr, stdout, shortMessage, message]
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

function formatGitFailure(base: string, details: string): string {
  const condensed = details.trim();
  if (!condensed) return base;
  return `${base}\n${condensed}`;
}

function isMissingBranchCheckoutError(output: string, name: string): boolean {
  const normalized = output.toLowerCase();
  if (
    normalized.includes(`pathspec '${name.toLowerCase()}' did not match`) ||
    normalized.includes(`invalid reference: ${name.toLowerCase()}`)
  ) {
    return true;
  }
  return normalized.includes('did not match any file(s) known to git');
}

function isFastForwardConflictError(output: string): boolean {
  const normalized = output.toLowerCase();
  return (
    normalized.includes('not possible to fast-forward') ||
    normalized.includes('cannot fast-forward')
  );
}

/** A commit on a branch range. */
export interface CommitInfo {
  sha: string;
  subject: string;
}

/**
 * Lists commits reachable from `headRef` but not from `baseRef`, oldest first.
 */
export async function listCommitsBetween(
  baseRef: string,
  headRef: string,
  cwd: string,
): Promise<CommitInfo[]> {
  // Use ASCII unit separator (0x1f) as the SHA/subject delimiter — git
  // disallows control characters in commit subjects, so this byte cannot
  // appear inside %s and parsing stays unambiguous even for commit messages
  // that contain `<<<...>>>`-style markers, pipes, tabs, or other quoting.
  const FIELD_SEP = '\x1f';
  try {
    const { stdout } = await execa(
      'git',
      [
        'log',
        '--reverse',
        `--format=%H${FIELD_SEP}%s`,
        `${baseRef}..${headRef}`,
      ],
      { cwd },
    );
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const sepIdx = line.indexOf(FIELD_SEP);
        if (sepIdx === -1) return { sha: line.trim(), subject: '' };
        return {
          sha: line.slice(0, sepIdx).trim(),
          subject: line.slice(sepIdx + 1).trim(),
        };
      })
      .filter((c) => c.sha.length > 0);
  } catch {
    throw new DubError(`Failed to list commits in ${baseRef}..${headRef}.`, [
      `Run 'git log ${baseRef}..${headRef}' manually to inspect the error.`,
    ]);
  }
}

/**
 * Cherry-picks a commit onto the current branch.
 * @throws {DubError} On conflict or git failure.
 */
export async function cherryPick(sha: string, cwd: string): Promise<void> {
  try {
    await execa('git', ['cherry-pick', sha], { cwd });
  } catch (error) {
    throw new DubError(
      formatGitFailure(
        `Cherry-pick of '${sha}' failed.`,
        readGitCommandOutput(error),
      ),
      [
        "Resolve conflicts and run 'git cherry-pick --continue'.",
        "Run 'git cherry-pick --abort' to roll back the cherry-pick.",
      ],
    );
  }
}

/**
 * Aborts an in-progress cherry-pick.
 */
export async function cherryPickAbort(cwd: string): Promise<void> {
  try {
    await execa('git', ['cherry-pick', '--abort'], { cwd });
  } catch {
    // ignore — no cherry-pick in progress
  }
}

/**
 * Hard-resets the currently checked-out branch to a SHA.
 * @throws {DubError} If reset fails.
 */
export async function resetHard(ref: string, cwd: string): Promise<void> {
  try {
    await execa('git', ['reset', '--hard', ref], { cwd });
  } catch (error) {
    throw new DubError(
      formatGitFailure(
        `Failed to reset current branch to '${ref}'.`,
        readGitCommandOutput(error),
      ),
      [
        "Run 'git status' to inspect uncommitted changes blocking the reset.",
        "Run 'git stash' to set aside local changes, then retry.",
      ],
    );
  }
}

/**
 * Checks out specific paths from a ref into the working tree.
 * Used by split to copy file contents from one branch to another.
 */
export async function checkoutPathsFromRef(
  ref: string,
  paths: string[],
  cwd: string,
): Promise<void> {
  if (paths.length === 0) return;
  try {
    await execa('git', ['checkout', ref, '--', ...paths], { cwd });
  } catch (error) {
    throw new DubError(
      formatGitFailure(
        `Failed to checkout paths from '${ref}'.`,
        readGitCommandOutput(error),
      ),
      [
        `Run 'git checkout ${ref} -- ${paths.join(' ')}' manually to inspect the error.`,
      ],
    );
  }
}

/**
 * Adds (stages) the given paths.
 */
export async function addPaths(paths: string[], cwd: string): Promise<void> {
  if (paths.length === 0) return;
  try {
    await execa('git', ['add', '--', ...paths], { cwd });
  } catch (error) {
    throw new DubError(
      formatGitFailure('Failed to stage paths.', readGitCommandOutput(error)),
      [`Run 'git add ${paths.join(' ')}' manually to inspect the error.`],
    );
  }
}

/**
 * Removes the given paths from the index and working tree.
 * Used by split when extracting a new file to the new branch — the original
 * branch must drop the file so the split is net-zero.
 */
export async function removePaths(paths: string[], cwd: string): Promise<void> {
  if (paths.length === 0) return;
  try {
    await execa('git', ['rm', '-f', '--', ...paths], { cwd });
  } catch (error) {
    throw new DubError(
      formatGitFailure('Failed to remove paths.', readGitCommandOutput(error)),
      [`Run 'git rm -f ${paths.join(' ')}' manually to inspect the error.`],
    );
  }
}

/**
 * Returns the list of paths that exist (as files) at the given ref.
 */
export async function listPathsAtRef(
  ref: string,
  paths: string[],
  cwd: string,
): Promise<string[]> {
  if (paths.length === 0) return [];
  try {
    const { stdout } = await execa(
      'git',
      ['ls-tree', '-r', '--name-only', ref, '--', ...paths],
      { cwd },
    );
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Runs `git checkout -p <ref>` interactively so the user picks hunks from
 * `ref` to apply to the working tree of the current branch.
 *
 * Uses `stdio: 'inherit'` so the user can interact with git directly.
 */
export async function interactivePatchCheckout(
  ref: string,
  cwd: string,
): Promise<void> {
  try {
    await execa('git', ['checkout', '-p', ref], { cwd, stdio: 'inherit' });
  } catch (error) {
    throw new DubError(
      formatGitFailure(
        'Interactive hunk selection failed.',
        readGitCommandOutput(error),
      ),
      [
        `Run 'git checkout -p ${ref}' manually to inspect the error.`,
        "Run 'git status' to confirm the working tree state.",
      ],
    );
  }
}

/**
 * Creates a new branch starting at a specific commit/ref and switches to it.
 * Use this when you need the new branch anchored to a captured SHA rather
 * than a possibly-moving branch tip (e.g. so a background fetch updating
 * the parent ref cannot relocate the new branch's starting point).
 *
 * @throws {DubError} If a branch with that name already exists or `ref` is unknown.
 */
export async function createBranchFrom(
  name: string,
  ref: string,
  cwd: string,
): Promise<void> {
  if (await branchExists(name, cwd)) {
    throw new DubError(`Branch '${name}' already exists.`, [
      `Run 'dub checkout ${name}' to switch to the existing branch.`,
      'Pick a different branch name and retry.',
      `Run 'dub delete ${name}' to remove the existing branch first.`,
    ]);
  }
  try {
    await execa('git', ['checkout', '-b', name, ref], { cwd });
  } catch (error) {
    throw new DubError(
      formatGitFailure(
        `Failed to create branch '${name}' from '${ref}'.`,
        readGitCommandOutput(error),
      ),
      [
        `Run 'git rev-parse ${ref}' to confirm the ref exists.`,
        `Run 'git checkout -b ${name} ${ref}' manually to inspect the underlying error.`,
      ],
    );
  }
}

/**
 * Soft-resets the currently checked-out branch to a ref. Leaves the index
 * holding the difference between the old tip and `ref`, and the working tree
 * untouched.
 */
export async function softResetTo(ref: string, cwd: string): Promise<void> {
  try {
    await execa('git', ['reset', '--soft', ref], { cwd });
  } catch (error) {
    throw new DubError(
      formatGitFailure(
        `Failed to soft-reset current branch to '${ref}'.`,
        readGitCommandOutput(error),
      ),
      [`Run 'git reset --soft ${ref}' manually to inspect the error.`],
    );
  }
}

/**
 * Sentinel thrown by {@link interactiveResetPatch} when the user quits the
 * interactive prompt (presses `q`). Callers can branch on this to emit a
 * "split aborted by user" message instead of a generic git-failure error.
 */
export class InteractivePatchQuitError extends Error {
  constructor() {
    super('Interactive hunk session quit by user.');
    this.name = 'InteractivePatchQuitError';
  }
}

/**
 * Runs `git reset --patch HEAD` interactively so the user can selectively
 * unstage hunks. Hunks the user answers `y` to are unstaged into the working
 * tree; hunks answered `n` to remain in the index.
 *
 * @throws {InteractivePatchQuitError} If the user quit the prompt (exit code 1
 *   with no stderr — git's signal for a clean `q`).
 * @throws {DubError} For any other failure.
 */
export async function interactiveResetPatch(cwd: string): Promise<void> {
  try {
    await execa('git', ['reset', '--patch', 'HEAD'], {
      cwd,
      stdio: 'inherit',
    });
  } catch (error) {
    const exitCode = (error as { exitCode?: number }).exitCode;
    const stderr = readGitCommandOutput(error).trim();
    if (exitCode === 1 && stderr.length === 0) {
      // `git reset --patch` exits 1 with no stderr when the user presses `q`.
      throw new InteractivePatchQuitError();
    }
    throw new DubError(
      formatGitFailure('Interactive hunk reset failed.', stderr),
      [
        "Run 'git reset --patch HEAD' manually to inspect the error.",
        "Run 'git status' to confirm the working tree state.",
      ],
    );
  }
}

/**
 * Stashes the working-tree changes (including untracked files) while keeping
 * the index intact. Returns true if a stash entry was created, false when
 * there was nothing to stash.
 */
export async function stashKeepIndex(
  message: string,
  cwd: string,
): Promise<boolean> {
  try {
    const { stdout } = await execa(
      'git',
      ['stash', 'push', '--keep-index', '--include-untracked', '-m', message],
      { cwd },
    );
    return !/No local changes to save/i.test(stdout);
  } catch (error) {
    throw new DubError(
      formatGitFailure(
        'Failed to stash working-tree changes.',
        readGitCommandOutput(error),
      ),
      [
        "Run 'git stash push --keep-index --include-untracked' manually to inspect the error.",
      ],
    );
  }
}

/**
 * Pops the most recent stash entry. Throws on conflict.
 */
export async function stashPop(cwd: string): Promise<void> {
  try {
    await execa('git', ['stash', 'pop'], { cwd });
  } catch (error) {
    throw new DubError(
      formatGitFailure('Failed to pop stash.', readGitCommandOutput(error)),
      [
        "Run 'git stash list' to inspect the stashes.",
        "Run 'git stash pop' manually to inspect the error.",
      ],
    );
  }
}

/**
 * Drops the most recent stash entry. Best-effort — never throws.
 */
export async function stashDropTop(cwd: string): Promise<void> {
  try {
    await execa('git', ['stash', 'drop'], { cwd });
  } catch {
    // best-effort cleanup
  }
}

/**
 * Lists files changed between two refs (merge-base aware via `...`).
 */
export async function getDiffFileNamesBetween(
  baseRef: string,
  headRef: string,
  cwd: string,
): Promise<string[]> {
  try {
    const { stdout } = await execa(
      'git',
      ['diff', '--name-only', `${baseRef}...${headRef}`],
      { cwd },
    );
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}
