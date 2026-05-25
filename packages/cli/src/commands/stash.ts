import { DubError } from '../lib/errors';
import {
  branchExists,
  checkoutBranch,
  getCurrentBranch,
  gitStashPop,
  gitStashPushIncludeUntracked,
  isWorkingTreeClean,
  listGitStashes,
} from '../lib/git';
import {
  prependStashLogEntry,
  readStashLog,
  removeStashLogEntry,
  type StashLogEntry,
} from '../lib/stash-log';
import { ensureState } from '../lib/state';

export interface StashPushOptions {
  /** Optional user-supplied message. When omitted, a default with branch + timestamp is used. */
  message?: string;
  /** Preview the planned stash without invoking `git stash push`. */
  dryRun?: boolean;
}

export interface StashPushResult {
  branch: string;
  sha: string;
  message: string;
  createdAt: string;
  dryRun: boolean;
}

/**
 * Captures the working tree (staged + unstaged + untracked) as a `git stash`
 * entry, recording the source branch in `.git/dubstack/stash-log.json` so a
 * later {@link stashPop} can refuse a branch-mismatched pop.
 *
 * @throws {DubError} If the working tree is clean or the underlying git
 *   command fails.
 */
export async function stashPush(
  cwd: string,
  options: StashPushOptions = {},
): Promise<StashPushResult> {
  const dryRun = options.dryRun ?? false;
  if (!dryRun) await ensureState(cwd);
  const branch = await getCurrentBranch(cwd);

  if (await isWorkingTreeClean(cwd)) {
    throw new DubError('Nothing to stash — working tree is clean.', [
      "Make changes (or stage them with 'git add'), then rerun 'dub stash'.",
      "Run 'git status' to confirm the working tree state.",
    ]);
  }

  const createdAt = new Date().toISOString();
  const message =
    options.message?.trim() || `dub stash: ${branch} @ ${createdAt}`;

  if (dryRun) {
    return { branch, sha: '<would-stash>', message, createdAt, dryRun: true };
  }

  const sha = await gitStashPushIncludeUntracked(message, cwd);
  if (!sha) {
    throw new DubError('Git reported no changes to stash.', [
      "Run 'git status' to confirm the working tree state.",
      "If files are only ignored (.gitignore), 'git stash' will not include them.",
    ]);
  }

  const entry: StashLogEntry = { sha, branch, message, createdAt };
  // git stash push already succeeded above. If writing the log fails (disk
  // full, permissions), the stash itself is safe in git's stack — warn rather
  // than throw so the user isn't told the stash failed when it actually
  // succeeded. They can still recover the work via plain `git stash pop`.
  try {
    await prependStashLogEntry(entry, cwd);
  } catch (error) {
    console.warn(
      `⚠ Stashed via git stash, but failed to record in '.git/dubstack/stash-log.json' (${error instanceof Error ? error.message : String(error)}). The stash itself is safe at stash@{0} — run 'git stash list' to confirm, or 'git stash pop' to restore.`,
    );
  }

  return { branch, sha, message, createdAt, dryRun: false };
}

export interface StashPopOptions {
  /** Checkout this branch first, then pop the stash there. */
  on?: string;
  /** Allow popping onto the current branch even when it differs from the source branch. */
  force?: boolean;
  /** Preview the planned pop without checking out or applying the stash. */
  dryRun?: boolean;
}

export interface StashPopResult {
  /** Branch where the stash was applied. */
  branch: string;
  /** Source branch the stash was originally created on (from the log). */
  sourceBranch: string;
  /** Stash SHA that was popped. */
  sha: string;
  /** Stash message recorded in the log. */
  message: string;
  /** True when the user passed `--on` and we checked out before popping. */
  checkedOut: boolean;
  dryRun: boolean;
}

/**
 * Pops the most recent stash recorded in `.git/dubstack/stash-log.json`.
 *
 * Refuses to apply onto a different branch than the one the stash was created
 * on unless `--on <branch>` (which checks out the target first) or `--force`
 * (which applies on the current branch) is given.
 *
 * @throws {DubError} If the stash log is empty, the recorded stash is no
 *   longer present in `git stash list`, the source/current branches differ
 *   without override flags, or the underlying git pop fails.
 */
export async function stashPop(
  cwd: string,
  options: StashPopOptions = {},
): Promise<StashPopResult> {
  const dryRun = options.dryRun ?? false;
  if (!dryRun) await ensureState(cwd);
  const log = await readStashLog(cwd);
  if (log.length === 0) {
    throw new DubError('No dub stash entries to pop.', [
      "Run 'dub stash' to record a branch-aware stash first.",
      "Run 'git stash list' to inspect raw git stashes outside DubStack's log.",
    ]);
  }
  const entry = log[0];

  const gitStashes = await listGitStashes(cwd);
  const match = gitStashes.find((s) => s.sha === entry.sha);
  if (!match) {
    // Clean up the dangling log entry so the user can move forward, but
    // never let a log-write error mask the actionable "no longer present"
    // DubError below — the log cleanup is best-effort.
    if (!dryRun) {
      try {
        await removeStashLogEntry(entry.sha, cwd);
      } catch {
        // best-effort: leave the dangling entry; the user can re-pop later.
      }
    }
    throw new DubError(
      `Recorded stash for '${entry.branch}' (${entry.sha.slice(0, 7)}) is no longer in 'git stash list'.`,
      [
        "It was likely dropped or popped outside DubStack — run 'dub stash list' to see remaining entries.",
        "Run 'git stash list' to inspect the current raw stash stack.",
        "Run 'dub stash pop' again to try the next entry.",
      ],
    );
  }

  const currentBranch = await getCurrentBranch(cwd);
  let targetBranch = currentBranch;
  let checkedOut = false;

  if (options.on) {
    const desired = options.on.trim();
    if (!desired) {
      throw new DubError("'--on' requires a branch name.", [
        "Pass '--on <branch>' with the branch to apply the stash on.",
      ]);
    }
    if (!(await branchExists(desired, cwd))) {
      throw new DubError(`Branch '${desired}' does not exist.`, [
        `Run 'git branch --list ${desired}' to confirm the branch name.`,
        `Run 'git checkout -b ${desired}' to create the branch before retrying.`,
      ]);
    }
    if (desired !== currentBranch) {
      if (!dryRun) await checkoutBranch(desired, cwd);
      checkedOut = true;
    }
    targetBranch = desired;
  } else if (entry.branch !== currentBranch && !options.force) {
    throw new DubError(
      `Stash was created on '${entry.branch}' but you are on '${currentBranch}'.`,
      [
        `Run 'dub stash pop --on ${entry.branch}' to checkout '${entry.branch}' first.`,
        `Run 'dub stash pop --force' to apply on '${currentBranch}' anyway.`,
        "Run 'dub stash list' to see the recorded branch context.",
      ],
    );
  }

  if (dryRun) {
    return {
      branch: targetBranch,
      sourceBranch: entry.branch,
      sha: entry.sha,
      message: entry.message,
      checkedOut,
      dryRun: true,
    };
  }

  await gitStashPop(match.ref, cwd);
  // git has already removed the stash from its stack; if writing the log fails
  // here (disk full, permissions), the next `dub stash pop` will surface a
  // dangling entry and auto-remove it. Swallow the error so the user isn't
  // told the pop failed when the working-tree change actually succeeded.
  try {
    await removeStashLogEntry(entry.sha, cwd);
  } catch (error) {
    console.warn(
      `⚠ Popped stash but failed to update '.git/dubstack/stash-log.json' (${error instanceof Error ? error.message : String(error)}). Run 'dub stash pop' once more to clear the dangling entry.`,
    );
  }

  return {
    branch: targetBranch,
    sourceBranch: entry.branch,
    sha: entry.sha,
    message: entry.message,
    checkedOut,
    dryRun: false,
  };
}

export interface StashListItem extends StashLogEntry {
  /** Whether the stash is still present in `git stash list` (false → dropped externally). */
  present: boolean;
  /** Current `stash@{N}` reference when present, otherwise null. */
  ref: string | null;
}

export interface StashListResult {
  entries: StashListItem[];
}

/**
 * Returns the dub stash log annotated with each entry's current presence in
 * `git stash list`. Dangling entries (popped/dropped outside DubStack) are
 * surfaced so the user can prune them.
 */
export async function stashList(cwd: string): Promise<StashListResult> {
  await ensureState(cwd);
  const log = await readStashLog(cwd);
  if (log.length === 0) return { entries: [] };
  const gitStashes = await listGitStashes(cwd);
  const bySha = new Map(gitStashes.map((s) => [s.sha, s.ref] as const));
  const entries: StashListItem[] = log.map((entry) => {
    const ref = bySha.get(entry.sha) ?? null;
    return { ...entry, present: ref != null, ref };
  });
  return { entries };
}
