import { DubError } from '../lib/errors';
import { execa } from '../lib/exec';
import {
  branchExists,
  getBranchTip,
  getCurrentBranch,
  isValidBranchName,
  isWorkingTreeClean,
  remoteBranchExists,
} from '../lib/git';
import {
  checkGhAuth,
  ensureGhInstalled,
  getPrMergeInfoByNumber,
} from '../lib/github';
import { createProgress, logVerboseCommand } from '../lib/progress';
import { retry } from '../lib/retry';
import {
  addBranchToStack,
  type DubState,
  ensureState,
  findStackForBranch,
  writeState,
} from '../lib/state';
import { clearUndoEntry, saveUndoEntry } from '../lib/undo-log';
import { type SubmitResult, submit } from './submit';

export interface RevertOptions {
  /** Override the auto-generated branch name (`revert/<source>-<short>`). */
  branchName?: string;
  /** After creating the revert branch, push and open a PR via `dub submit`. */
  submit?: boolean;
  /** Open the editor for the revert commit message instead of `--no-edit`. */
  editMessage?: boolean;
}

export interface RevertResult {
  branch: string;
  trunk: string;
  revertedSha: string;
  /** Short SHA used in the auto-generated branch name. */
  revertedShortSha: string;
  /** Branch name the revert was derived from (PR head ref or `commit`). */
  sourceLabel: string;
  /** PR number when invoked with a PR number; null when invoked with a SHA. */
  prNumber: number | null;
  submitResult: SubmitResult | null;
}

const PR_NUMBER_PATTERN = /^#?\d+$/;
const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

/**
 * Creates a branch on trunk that reverts a merged commit or PR.
 *
 * Resolves `target` to a commit SHA — either by looking up the PR's merge
 * commit via `gh pr view` or by verifying the SHA exists locally — then
 * checks out a fresh branch rooted at `origin/<trunk>` (fetched first when
 * available), runs `git revert`, and tracks the result as a new stack root
 * for downstream `dub submit` / `dub merge-next` flows.
 *
 * @throws {DubError} If the PR is not merged, the SHA cannot be resolved,
 *   the working tree is dirty, the branch name collides, or git revert
 *   fails (e.g. conflicts).
 */
export async function revert(
  cwd: string,
  target: string,
  options: RevertOptions = {},
): Promise<RevertResult> {
  if (!target?.trim()) {
    throw new DubError('A PR number or commit SHA is required.', [
      "Run 'dub revert <pr-number>' to revert a merged PR.",
      "Run 'dub revert <commit-sha>' to revert a specific commit.",
    ]);
  }
  const trimmedTarget = target.trim();

  if (!(await isWorkingTreeClean(cwd))) {
    throw new DubError('Working tree has uncommitted changes.', [
      "Run 'git status' to see the uncommitted changes.",
      "Run 'git stash' to set the changes aside, then rerun 'dub revert'.",
      'Commit pending work first (\'dub modify -am "<message>"\'), then retry.',
    ]);
  }

  const state = await ensureState(cwd);
  const currentBranch = await getCurrentBranch(cwd);
  const trunk = await resolveRevertTrunk(state, currentBranch, cwd);

  const resolved = await resolveRevertTarget(trimmedTarget, cwd);

  const branchName =
    options.branchName?.trim() ||
    buildRevertBranchName(resolved.sourceLabel, resolved.shortSha);

  if (!(await isValidBranchName(branchName, cwd))) {
    throw new DubError(`Branch name '${branchName}' is invalid.`, [
      'Use only ASCII letters, digits, slashes, dots, dashes, and underscores.',
      "Pass '-b <name>' with a valid branch name and retry.",
    ]);
  }
  if (await branchExists(branchName, cwd)) {
    throw new DubError(`Branch '${branchName}' already exists.`, [
      `Run 'dub checkout ${branchName}' to switch to the existing branch.`,
      `Pass '-b <name>' to 'dub revert' with a unique branch name.`,
      `Run 'dub delete ${branchName}' to remove it before retrying.`,
    ]);
  }
  if (findStackForBranch(state, branchName)) {
    throw new DubError(
      `Branch '${branchName}' is already tracked in a stack.`,
      [
        `Pass '-b <name>' to 'dub revert' with a different branch name.`,
        `Run 'dub untrack ${branchName}' to detach it before retrying.`,
      ],
    );
  }

  const startBranch = currentBranch;
  const trunkStartPoint = await resolveTrunkStartPoint(trunk, cwd);

  // Save undo BEFORE the first git mutation. If we crash between `git
  // revert` succeeding and the state write, `dub undo` still has a snapshot
  // pointing at the branches that will be created.
  await saveUndoEntry(
    {
      operation: 'create',
      timestamp: new Date().toISOString(),
      previousBranch: startBranch,
      previousState: structuredClone(state),
      branchTips: {},
      createdBranches: [branchName],
    },
    cwd,
  );

  const progress = createProgress();
  // Three core steps: branch off trunk → run git revert → persist tracking.
  // Submit (when requested) is a fourth step driven inside the same bar.
  const totalSteps = options.submit ? 4 : 3;
  progress.start('Reverting', totalSteps);
  let stepIndex = 0;

  try {
    stepIndex += 1;
    progress.update('Reverting', stepIndex, `branch ${branchName}`);
    logVerboseCommand('git', ['checkout', '-b', branchName, trunkStartPoint]);
    try {
      await execa('git', ['checkout', '-b', branchName, trunkStartPoint], {
        cwd,
      });
    } catch (error) {
      // Checkout never started — drop the speculative undo entry so a later
      // `dub undo` doesn't try to delete a branch that was never created.
      await clearUndoEntry(cwd).catch(() => {});
      const message = error instanceof Error ? error.message : String(error);
      throw new DubError(
        `Failed to create revert branch '${branchName}' from '${trunkStartPoint}'.\n${message}`,
        [
          `Run 'git checkout -b ${branchName} ${trunkStartPoint}' manually to see the underlying error.`,
          `Run 'git fetch origin ${trunk}' to refresh the trunk ref, then retry.`,
        ],
      );
    }

    const revertArgs = ['revert', resolved.sha];
    revertArgs.push(options.editMessage ? '--edit' : '--no-edit');

    stepIndex += 1;
    progress.update('Reverting', stepIndex, `revert ${resolved.shortSha}`);
    logVerboseCommand('git', revertArgs);
    try {
      if (options.editMessage) {
        // `git revert --edit` opens an interactive editor; pausing the bar
        // hands the TTY back so the editor renders without the bar redrawing
        // over it. The bar resumes after the editor exits.
        progress.pause();
        try {
          await execa('git', revertArgs, { cwd, stdio: 'inherit' });
        } finally {
          progress.resume();
        }
      } else {
        await execa('git', revertArgs, { cwd, stdio: 'pipe' });
      }
    } catch (error) {
      // Roll back the branch creation so the user isn't left on a partial
      // revert branch with conflict markers. Only drop the undo entry when
      // the leaked branch was actually deleted — otherwise keep it so
      // `dub undo` remains a working recovery path for the user.
      await safeAbortRevert(cwd);
      const rollback = await safeRollbackBranch(branchName, startBranch, cwd);
      if (rollback.deleted) {
        await clearUndoEntry(cwd).catch(() => {});
      }
      const message = error instanceof Error ? error.message : String(error);
      const recovery = [
        `Run 'git revert ${resolved.sha}' on a branch from '${trunk}' to inspect conflicts.`,
        `Confirm the commit exists by running 'git log ${resolved.sha}'.`,
      ];
      if (!rollback.deleted) {
        recovery.unshift(
          `Run 'dub undo' to delete the leaked '${branchName}' branch.`,
        );
      }
      throw new DubError(
        `Failed to revert '${resolved.sha}' on '${branchName}'.\n${message}`,
        recovery,
      );
    }

    stepIndex += 1;
    progress.update('Reverting', stepIndex, 'tracking branch');
    const trunkTipSha = await getBranchTip(trunk, cwd).catch(() => null);
    addBranchToStack(state, branchName, trunk, trunkTipSha ?? undefined);
    await writeState(state, cwd);

    let submitResult: SubmitResult | null = null;
    if (options.submit) {
      stepIndex += 1;
      progress.update('Reverting', stepIndex, 'submitting PR');
      try {
        submitResult = await submit(cwd, false, { branch: branchName });
      } catch (error) {
        // The revert branch is on disk and tracked — surfacing the bare
        // submit error would hide that fact. Re-raise with a hint pointing
        // at the manual submit so the user knows what to do next.
        progress.stop();
        const message = error instanceof Error ? error.message : String(error);
        throw new DubError(
          `Revert branch '${branchName}' was created but 'dub submit' failed.\n${message}`,
          [
            `Run 'dub submit --branch ${branchName}' once the submit failure is resolved.`,
            `Run 'dub log' to confirm '${branchName}' is tracked under '${trunk}'.`,
            `Run 'dub delete ${branchName}' to discard the revert branch entirely.`,
          ],
        );
      }
    }

    progress.complete('Revert complete');
    return {
      branch: branchName,
      trunk,
      revertedSha: resolved.sha,
      revertedShortSha: resolved.shortSha,
      sourceLabel: resolved.sourceLabel,
      prNumber: resolved.prNumber,
      submitResult,
    };
  } catch (error) {
    progress.stop();
    throw error;
  }
}

interface ResolvedTarget {
  sha: string;
  shortSha: string;
  /** Branch name the revert was derived from, or `'commit'` for raw SHAs. */
  sourceLabel: string;
  prNumber: number | null;
}

class CommitNotFoundError extends DubError {}

class PrNotFoundError extends DubError {}

async function resolveRevertTarget(
  target: string,
  cwd: string,
): Promise<ResolvedTarget> {
  if (target.startsWith('#')) {
    return resolvePrTarget(target.replace(/^#/, ''), cwd);
  }
  if (SHA_PATTERN.test(target)) {
    try {
      return await resolveShaTarget(target, cwd);
    } catch (error) {
      if (
        PR_NUMBER_PATTERN.test(target) &&
        error instanceof CommitNotFoundError
      ) {
        try {
          return await resolvePrTarget(target, cwd);
        } catch (prError) {
          if (prError instanceof PrNotFoundError) {
            throw error;
          }
          throw prError;
        }
      }
      throw error;
    }
  }
  if (PR_NUMBER_PATTERN.test(target)) {
    return resolvePrTarget(target, cwd);
  }
  throw new DubError(
    `'${target}' is not a recognized PR number or commit SHA.`,
    [
      "Pass a numeric PR number (e.g. 'dub revert 123' or '#123').",
      "Pass a commit SHA (7-40 hex chars) like 'dub revert abc1234'.",
    ],
  );
}

async function resolvePrTarget(
  rawPrNumber: string,
  cwd: string,
): Promise<ResolvedTarget> {
  const prNumber = Number.parseInt(rawPrNumber, 10);
  if (!Number.isFinite(prNumber) || prNumber <= 0) {
    throw new DubError(`'${rawPrNumber}' is not a valid PR number.`, [
      'Pass a positive integer PR number, e.g. `dub revert 123`.',
    ]);
  }

  await ensureGhInstalled();
  await checkGhAuth();

  const info = await getPrMergeInfoByNumber(prNumber, cwd);
  if (!info) {
    throw new PrNotFoundError(`PR #${prNumber} was not found.`, [
      `Run 'gh pr view ${prNumber}' to confirm the PR exists in this repository.`,
      `Pass a commit SHA directly: 'dub revert <sha>'.`,
    ]);
  }
  if (info.state !== 'MERGED') {
    throw new DubError(
      `PR #${prNumber} is ${info.state.toLowerCase()}, not merged — nothing to revert.`,
      [
        `Run 'gh pr view ${prNumber}' to confirm the merge status.`,
        'Wait until the PR is merged, then rerun `dub revert`.',
        `Pass a commit SHA directly to revert work that was never merged via PR: 'dub revert <sha>'.`,
      ],
    );
  }
  if (!info.mergeCommitSha) {
    throw new DubError(
      `PR #${prNumber} is merged but has no merge commit on file.`,
      [
        `Run 'gh pr view ${prNumber} --json mergeCommit' to inspect the response.`,
        `Pass the merge commit SHA directly: 'dub revert <sha>'.`,
      ],
    );
  }

  const sha = await verifyCommit(info.mergeCommitSha, cwd, {
    fetchHint: `git fetch origin '+refs/heads/*:refs/remotes/origin/*'`,
  });
  const shortSha = sha.slice(0, 7);
  const sourceLabel = leafBranchName(info.headRefName) ?? `pr-${prNumber}`;
  return { sha, shortSha, sourceLabel, prNumber };
}

async function resolveShaTarget(
  target: string,
  cwd: string,
): Promise<ResolvedTarget> {
  const sha = await verifyCommit(target, cwd, {
    fetchHint: 'git fetch origin',
  });
  return {
    sha,
    shortSha: sha.slice(0, 7),
    sourceLabel: 'commit',
    prNumber: null,
  };
}

async function verifyCommit(
  ref: string,
  cwd: string,
  hints: { fetchHint: string },
): Promise<string> {
  try {
    const { stdout } = await execa(
      'git',
      ['rev-parse', '--verify', `${ref}^{commit}`],
      { cwd },
    );
    return stdout.trim();
  } catch (error) {
    const stderr =
      typeof (error as { stderr?: unknown }).stderr === 'string'
        ? (error as { stderr: string }).stderr.toLowerCase()
        : '';
    // `git rev-parse --verify` distinguishes "missing" from "ambiguous short
    // SHA". Surface the latter with a different hint so the user supplies a
    // longer prefix instead of refetching.
    if (
      stderr.includes('ambiguous argument') ||
      stderr.includes('short sha1')
    ) {
      throw new DubError(
        `Commit '${ref}' is an ambiguous short SHA in this repository.`,
        [
          'Pass a longer prefix (or the full 40-char SHA) and retry.',
          `Run 'git rev-parse --disambiguate=${ref}' to see the candidate commits.`,
        ],
      );
    }
    throw new CommitNotFoundError(
      `Commit '${ref}' not found in this repository.`,
      [
        `Run '${hints.fetchHint}' to fetch missing history, then retry.`,
        `Run 'git log ${ref}' manually to confirm the commit exists.`,
      ],
    );
  }
}

async function resolveRevertTrunk(
  state: DubState,
  currentBranch: string,
  cwd: string,
): Promise<string> {
  const currentStack = findStackForBranch(state, currentBranch);
  const currentRoot = currentStack?.branches.find((b) => b.type === 'root');
  if (currentRoot) return currentRoot.name;

  const trackedRoots = new Set(
    state.stacks
      .map((stack) => stack.branches.find((b) => b.type === 'root')?.name)
      .filter((name): name is string => Boolean(name)),
  );
  if (trackedRoots.size === 1) {
    const [only] = trackedRoots;
    return only;
  }
  if (await branchExists('main', cwd)) return 'main';
  if (await branchExists('master', cwd)) return 'master';
  throw new DubError('Could not determine the trunk branch.', [
    "Run 'dub track <branch> --parent <trunk>' to register a trunk first.",
    "Checkout a branch within a tracked stack so 'dub revert' can infer its trunk.",
  ]);
}

async function resolveTrunkStartPoint(
  trunk: string,
  cwd: string,
): Promise<string> {
  // Refresh the remote ref so the revert branch starts from the freshest tip
  // we can reach. Failure here is non-fatal — the local trunk is still a
  // reasonable fallback for offline use.
  await fetchTrunkSafely(trunk, cwd);
  if (await remoteBranchExists(trunk, cwd)) {
    return `origin/${trunk}`;
  }
  if (await branchExists(trunk, cwd)) {
    return trunk;
  }
  throw new DubError(`Trunk '${trunk}' is missing locally and on the remote.`, [
    `Run 'git fetch origin ${trunk}' to fetch the trunk.`,
    `Run 'git branch ${trunk} origin/${trunk}' once the remote ref exists, then retry.`,
  ]);
}

async function fetchTrunkSafely(trunk: string, cwd: string): Promise<void> {
  try {
    await retry(() => execa('git', ['fetch', 'origin', trunk], { cwd }), {
      isPermanent: (err) => {
        const message = err instanceof Error ? err.message : String(err);
        return /authentication failed|repository not found|couldn't find remote ref/i.test(
          message,
        );
      },
    });
  } catch (err) {
    // Best-effort. Offline runs or missing remotes should still be able to
    // revert from a local trunk ref; resolveTrunkStartPoint surfaces a clearer
    // error if no usable trunk ref exists at all. Surface the failure under
    // --verbose so users can spot a stale revert base when something looks off.
    logVerboseCommand('fetch-trunk-failed', [
      `trunk=${trunk}`,
      String(err instanceof Error ? err.message : err),
    ]);
  }
}

function buildRevertBranchName(sourceLabel: string, shortSha: string): string {
  const slug = sanitizeBranchSegment(sourceLabel) || 'commit';
  return `revert/${slug}-${shortSha}`;
}

/**
 * Drops any leading path so the generated branch name stays a single
 * `revert/<leaf>` segment instead of nesting (`revert/feature/foo`).
 */
function leafBranchName(name: string | null): string | null {
  if (!name) return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  const lastSlash = trimmed.lastIndexOf('/');
  return lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed;
}

function sanitizeBranchSegment(value: string): string {
  return value
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

async function safeAbortRevert(cwd: string): Promise<void> {
  try {
    await execa('git', ['revert', '--abort'], { cwd });
  } catch {
    // Nothing to abort, or git already cleaned up — proceed to rollback.
  }
}

async function safeRollbackBranch(
  branch: string,
  fallbackBranch: string,
  cwd: string,
): Promise<{ deleted: boolean }> {
  // Step off the partial branch before deleting it. A failed `git revert`
  // may leave conflict markers in the working tree even after `--abort`, so
  // try a normal checkout first (preserves any data the user has on disk),
  // then fall back to `-f` so we can still drop the leaked branch.
  let switched = false;
  if (await branchExists(fallbackBranch, cwd)) {
    try {
      await execa('git', ['checkout', fallbackBranch], { cwd });
      switched = true;
    } catch {
      try {
        await execa('git', ['checkout', '-f', fallbackBranch], { cwd });
        switched = true;
      } catch (err) {
        logVerboseCommand('rollback-checkout-failed', [
          `fallback=${fallbackBranch}`,
          String(err instanceof Error ? err.message : err),
        ]);
      }
    }
  }

  if (!switched) {
    // `git branch -D` refuses to delete the currently checked-out branch,
    // so when we couldn't switch off we surface the leaked branch instead
    // of silently failing to clean it up. The caller keeps the undo entry
    // alive so `dub undo` can complete the cleanup once the user resolves
    // whatever blocked the checkout.
    if (await branchExists(branch, cwd)) {
      console.warn(
        `⚠ Revert branch '${branch}' is still checked out — run 'dub undo' after switching off (or 'git checkout -f ${fallbackBranch} && git branch -D ${branch}') to clean up.`,
      );
    }
    return { deleted: false };
  }

  if (!(await branchExists(branch, cwd))) {
    return { deleted: true };
  }
  try {
    await execa('git', ['branch', '-D', branch], { cwd });
    return { deleted: true };
  } catch (err) {
    logVerboseCommand('rollback-delete-failed', [
      `branch=${branch}`,
      String(err instanceof Error ? err.message : err),
    ]);
    console.warn(
      `⚠ Revert branch '${branch}' was left behind — run 'dub undo' to remove it.`,
    );
    return { deleted: false };
  }
}

export const __testing = {
  buildRevertBranchName,
  leafBranchName,
  sanitizeBranchSegment,
};
