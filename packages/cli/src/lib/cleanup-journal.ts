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
  /** The PR base recorded before retarget. Used only as a replay safety net. */
  oldBase: string | null;
  /** Desired new PR base. */
  newBase: string;
  /** Optional PR number, for callers that already know it. */
  prNumber?: number;
}

export type CleanupOperation =
  | CleanupDeleteOp
  | CleanupReparentOp
  | CleanupRetargetOp;

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
      "Delete the journal manually and re-run 'dub sync' if it cannot be recovered.",
    ]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DubError(
      `Cleanup journal at '${journalPath}' is not valid JSON.`,
      [
        "Inspect the file and remove it if it cannot be repaired, then re-run 'dub sync'.",
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
      'Delete the file and re-run `dub sync` to regenerate it.',
    ]);
  }
  return parsed as CleanupJournal;
}

export async function startCleanupJournal(
  cwd: string,
): Promise<CleanupJournal> {
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
