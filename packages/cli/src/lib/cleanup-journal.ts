import * as fs from 'node:fs';
import * as path from 'node:path';
import { DubError } from './errors';
import { getDubDir } from './state';

export type CleanupReason =
  | 'merged-pr'
  | 'merged-pr-with-trailing-commits'
  | 'closed-pr-merged-into-trunk'
  | 'merged-by-patch-id'
  /** Branch has zero unique commits relative to its parent. */
  | 'empty-branch';

export interface CleanupDeleteOp {
  type: 'delete';
  branch: string;
  reason: CleanupReason;
}

export interface CleanupReparentOp {
  type: 'reparent';
  branch: string;
  oldParent: string | null;
  newParent: string | null;
}

export interface CleanupRetargetOp {
  type: 'retarget';
  /** Branch whose open PR is being retargeted. */
  branch: string;
  /** Desired new PR base. */
  newBase: string;
}

/**
 * Records the intent to track a newly-created sibling branch in `state.json`
 * after the git side of a `dub split` extractor has landed both commits
 * cleanly.
 *
 * Why this op exists: the extractor commits the new branch and the source
 * removal commit (rolling back both on failure), then needs to persist the
 * new branch to state. A crash between "git side done" and "state.json
 * written" leaves an orphaned branch that DubStack doesn't know about.
 * Replay reconciles state from git: if the branch exists in git but not in
 * state, it gets added; otherwise the op is a no-op.
 *
 * Idempotency: keyed off the branch name; replay first checks both git and
 * state, and skips when the branch already appears in state or no longer
 * exists in git (which means the extractor rolled back).
 */
export interface CleanupSplitTrackBranchOp {
  type: 'split-track-branch';
  /** Name of the newly-created sibling branch. */
  branch: string;
  /** Parent branch the sibling was created off of. */
  parent: string;
  /** Parent tip SHA at split time — recorded as `parent_revision` in state. */
  parentTip: string;
  /** Source branch the split was driven from. Carried for diagnostic output. */
  sourceBranch: string;
}

/**
 * Records that the source branch's existing PR was closed (because the split
 * left the source branch empty vs its parent) and the corresponding
 * `pr_number` / `pr_link` should be nulled in state.
 *
 * Idempotency: replay first checks state; if `pr_number` is already `null`,
 * the op is a no-op.
 */
export interface CleanupSplitClearSourcePrOp {
  type: 'split-clear-source-pr';
  /** Source branch whose state pr_number/pr_link should be nulled. */
  branch: string;
}

export type CleanupOperation =
  | CleanupDeleteOp
  | CleanupReparentOp
  | CleanupRetargetOp
  | CleanupSplitTrackBranchOp
  | CleanupSplitClearSourcePrOp;

export const CLEANUP_JOURNAL_FILENAME = 'cleanup-journal.json';

export interface CleanupJournal {
  /**
   * Schema version. Bump when the on-disk format changes so older `dub continue`
   * runs can refuse to replay an incompatible journal instead of silently
   * misbehaving.
   */
  version: 1;
  /** ISO timestamp the cleanup phase started. */
  started_at: string;
  /** Operations in the exact order they were planned/executed. */
  operations: CleanupOperation[];
}

export async function getCleanupJournalPath(cwd: string): Promise<string> {
  const dubDir = await getDubDir(cwd);
  return path.join(dubDir, CLEANUP_JOURNAL_FILENAME);
}

export async function hasCleanupJournal(cwd: string): Promise<boolean> {
  const journalPath = await getCleanupJournalPath(cwd);
  return fs.existsSync(journalPath);
}

export async function readCleanupJournal(
  cwd: string,
): Promise<CleanupJournal | null> {
  const journalPath = await getCleanupJournalPath(cwd);
  if (!fs.existsSync(journalPath)) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(journalPath, 'utf8');
  } catch {
    throw new DubError(`Failed to read cleanup journal at '${journalPath}'.`, [
      `Check filesystem permissions on '${journalPath}'.`,
      "Run 'dub continue' to retry, or delete the journal manually if it cannot be recovered.",
    ]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DubError(
      `Cleanup journal at '${journalPath}' is not valid JSON.`,
      [
        'Inspect the file and remove it if it cannot be repaired, then re-run the interrupted command.',
      ],
    );
  }
  if (
    typeof parsed !== 'object' ||
    parsed == null ||
    (parsed as { version?: unknown }).version !== 1 ||
    !Array.isArray((parsed as { operations?: unknown }).operations)
  ) {
    throw new DubError(`Cleanup journal at '${journalPath}' is malformed.`, [
      'Delete the file and re-run the interrupted command to regenerate it.',
    ]);
  }
  return parsed as CleanupJournal;
}

export async function startCleanupJournal(
  cwd: string,
): Promise<CleanupJournal> {
  // Refuse to clobber an existing journal. A stale journal from a prior crash
  // must be replayed (`dub continue`) or discarded (`dub abort`) before a new
  // cleanup phase starts; otherwise we'd silently lose the prior run's pending
  // ops.
  if (await hasCleanupJournal(cwd)) {
    throw new DubError(
      'A cleanup journal already exists — another DubStack operation may be incomplete.',
      [
        "Run 'dub continue' to finish replaying the interrupted operation.",
        "Run 'dub abort' to discard the pending operation and start fresh.",
      ],
    );
  }
  const journal: CleanupJournal = {
    version: 1,
    started_at: new Date().toISOString(),
    operations: [],
  };
  await writeCleanupJournal(cwd, journal);
  return journal;
}

export async function appendCleanupOperation(
  cwd: string,
  journal: CleanupJournal,
  op: CleanupOperation,
): Promise<void> {
  journal.operations.push(op);
  await writeCleanupJournal(cwd, journal);
}

export async function clearCleanupJournal(cwd: string): Promise<void> {
  const journalPath = await getCleanupJournalPath(cwd);
  if (!fs.existsSync(journalPath)) return;
  fs.unlinkSync(journalPath);
}

async function writeCleanupJournal(
  cwd: string,
  journal: CleanupJournal,
): Promise<void> {
  const journalPath = await getCleanupJournalPath(cwd);
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  // Write atomically so a crash mid-write can't leave a half-flushed file
  // that subsequent `dub continue` runs would fail to parse.
  const tmp = `${journalPath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(journal, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, journalPath);
}
