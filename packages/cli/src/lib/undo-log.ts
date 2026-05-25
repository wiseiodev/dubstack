import * as fs from 'node:fs';
import * as path from 'node:path';
import { DubError } from './errors';
import type { DubState } from './state';
import { getDubDir } from './state';

/** Maximum entries kept in the undo/redo ring buffers. */
export const MAX_UNDO_ENTRIES = 20;

/** Operations that can be undone. */
export type UndoOperation =
  | 'create'
  | 'restack'
  | 'rename'
  | 'move'
  | 'pop'
  | 'reorder'
  | 'freeze'
  | 'unfreeze'
  | 'absorb'
  | 'unlink'
  | 'track'
  | 'untrack'
  | 'delete'
  | 'modify'
  | 'sync'
  | 'split'
  | 'submit';

/**
 * Snapshot of system state taken before a mutating command, used by
 * `dub undo` to reverse the change.
 */
export interface UndoEntry {
  /** Which command created this snapshot. */
  operation: UndoOperation;
  /** ISO timestamp of when the snapshot was taken. */
  timestamp: string;
  /** The branch user was on before the operation. */
  previousBranch: string;
  /** Full copy of state.json before mutation. */
  previousState: DubState;
  /** Map of branch name → commit SHA before mutation. */
  branchTips: Record<string, string>;
  /** Branches created by this operation (deleted on undo). */
  createdBranches: string[];
  /** Branches deleted by this operation (surfaced as recreate hint on undo). */
  deletedBranches?: string[];
  /** For `rename`: the original branch name before the rename. */
  renameFrom?: string;
  /** For `rename`: the new branch name after the rename. */
  renameTo?: string;
  /**
   * For `rename`: true when the renamed branch had been pushed (PR linked or
   * `last_submitted_version` set). Lets `dub undo` warn that the remote may
   * now diverge from the restored local name.
   */
  hadRemote?: boolean;
  /**
   * For `submit`: map of PR number → previous body. Undo replays each via
   * `gh pr edit --body-file` to restore the prior text. Best-effort; partial
   * failures are surfaced.
   */
  prBodies?: Record<string, string>;
  /** Optional human-readable summary surfaced by `dub undo --list`. */
  summary?: string;
  /**
   * Snapshot captured at undo time so `dub redo` can replay forward.
   * Omitted on entries that were never undone.
   */
  postSnapshot?: PostSnapshot;
}

/**
 * Snapshot of the world right before `dub undo` reversed an operation.
 * Persisted on the redo ring so `dub redo` can restore it.
 */
export interface PostSnapshot {
  /** Branch user was on right before undo (where redo will land them). */
  branch: string;
  /** State.json right before undo. */
  state: DubState;
  /** Map of branch name → tip SHA right before undo. */
  branchTips: Record<string, string>;
}

async function getUndoLogPath(cwd: string): Promise<string> {
  const dubDir = await getDubDir(cwd);
  return path.join(dubDir, 'undo-log.json');
}

async function getRedoLogPath(cwd: string): Promise<string> {
  const dubDir = await getDubDir(cwd);
  return path.join(dubDir, 'redo-log.json');
}

async function getLegacyUndoPath(cwd: string): Promise<string> {
  const dubDir = await getDubDir(cwd);
  return path.join(dubDir, 'undo.json');
}

function readEntries(filePath: string): UndoEntry[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed as UndoEntry[];
    // Legacy single-entry shape.
    return [parsed as UndoEntry];
  } catch {
    return [];
  }
}

function writeEntries(filePath: string, entries: UndoEntry[]): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (entries.length === 0) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return;
  }
  fs.writeFileSync(filePath, `${JSON.stringify(entries, null, 2)}\n`);
}

async function migrateLegacyEntry(cwd: string): Promise<void> {
  const legacyPath = await getLegacyUndoPath(cwd);
  const undoPath = await getUndoLogPath(cwd);
  if (!fs.existsSync(legacyPath)) return;
  if (fs.existsSync(undoPath)) {
    // Both present — drop the legacy file; the new log is authoritative.
    fs.unlinkSync(legacyPath);
    return;
  }
  // Parse the legacy file directly (not via readEntries, which swallows
  // JSON errors and returns []). If parsing fails, rename to .bak instead of
  // deleting so a partial-write crash can be recovered by hand.
  let legacy: UndoEntry[];
  try {
    const raw = fs.readFileSync(legacyPath, 'utf-8').trim();
    if (!raw) {
      fs.unlinkSync(legacyPath);
      return;
    }
    const parsed = JSON.parse(raw) as unknown;
    legacy = Array.isArray(parsed)
      ? (parsed as UndoEntry[])
      : [parsed as UndoEntry];
  } catch {
    // Preserve the corrupt file for manual recovery rather than discarding.
    fs.renameSync(legacyPath, `${legacyPath}.bak`);
    return;
  }
  if (legacy.length > 0) {
    writeEntries(undoPath, legacy);
  }
  fs.unlinkSync(legacyPath);
}

/**
 * Reads the entire undo ring (oldest first). Migrates the legacy single-entry
 * file the first time it's seen.
 */
export async function readUndoLog(cwd: string): Promise<UndoEntry[]> {
  await migrateLegacyEntry(cwd);
  const undoPath = await getUndoLogPath(cwd);
  return readEntries(undoPath);
}

/** Reads the redo ring (oldest first). */
export async function readRedoLog(cwd: string): Promise<UndoEntry[]> {
  const redoPath = await getRedoLogPath(cwd);
  return readEntries(redoPath);
}

/**
 * Appends an undo entry to the ring. The ring is capped at
 * `MAX_UNDO_ENTRIES`; older entries are dropped silently. Any pending redo
 * entries are cleared because the user has just performed a new mutation.
 *
 * Best-effort: filesystem failures are swallowed so a broken undo log can
 * never crash the originating command. The user simply loses the ability to
 * undo that operation.
 */
export async function saveUndoEntry(
  entry: UndoEntry,
  cwd: string,
): Promise<void> {
  try {
    await migrateLegacyEntry(cwd);
    const undoPath = await getUndoLogPath(cwd);
    const redoPath = await getRedoLogPath(cwd);
    const existing = readEntries(undoPath);
    existing.push(entry);
    while (existing.length > MAX_UNDO_ENTRIES) existing.shift();
    writeEntries(undoPath, existing);
    // New mutation invalidates the redo stack.
    if (fs.existsSync(redoPath)) fs.unlinkSync(redoPath);
  } catch {
    // Best-effort: undo log is non-critical infrastructure.
  }
}

/**
 * Returns the most recent undo entry without removing it.
 * @throws {DubError} If the undo log is empty.
 */
export async function readUndoEntry(cwd: string): Promise<UndoEntry> {
  const entries = await readUndoLog(cwd);
  if (entries.length === 0) {
    throw new DubError('Nothing to undo.', [
      'DubStack tracks the last 20 mutating operations; perform one to enable undo.',
    ]);
  }
  return entries[entries.length - 1];
}

/**
 * Pops and returns the most recent undo entry from the ring.
 * @throws {DubError} If the undo log is empty.
 */
export async function popUndoEntry(cwd: string): Promise<UndoEntry> {
  const entries = await readUndoLog(cwd);
  if (entries.length === 0) {
    throw new DubError('Nothing to undo.', [
      'DubStack tracks the last 20 mutating operations; perform one to enable undo.',
    ]);
  }
  const entry = entries.pop() as UndoEntry;
  const undoPath = await getUndoLogPath(cwd);
  writeEntries(undoPath, entries);
  return entry;
}

/**
 * Removes the most recent undo entry from the ring (no-op if empty). Kept
 * for backwards compatibility with the old single-level API.
 */
export async function clearUndoEntry(cwd: string): Promise<void> {
  const entries = await readUndoLog(cwd);
  if (entries.length === 0) return;
  entries.pop();
  const undoPath = await getUndoLogPath(cwd);
  writeEntries(undoPath, entries);
}

/** Clears the entire undo and redo ring buffers. */
export async function clearUndoLog(cwd: string): Promise<void> {
  await migrateLegacyEntry(cwd);
  const undoPath = await getUndoLogPath(cwd);
  const redoPath = await getRedoLogPath(cwd);
  if (fs.existsSync(undoPath)) fs.unlinkSync(undoPath);
  if (fs.existsSync(redoPath)) fs.unlinkSync(redoPath);
}

/** Pushes an entry onto the redo ring (capped at `MAX_UNDO_ENTRIES`). */
export async function pushRedoEntry(
  entry: UndoEntry,
  cwd: string,
): Promise<void> {
  const redoPath = await getRedoLogPath(cwd);
  const existing = readEntries(redoPath);
  existing.push(entry);
  while (existing.length > MAX_UNDO_ENTRIES) existing.shift();
  writeEntries(redoPath, existing);
}

/**
 * Pops the most recent redo entry. Returns null if none exist.
 */
export async function popRedoEntry(cwd: string): Promise<UndoEntry | null> {
  const entries = await readRedoLog(cwd);
  if (entries.length === 0) return null;
  const entry = entries.pop() as UndoEntry;
  const redoPath = await getRedoLogPath(cwd);
  writeEntries(redoPath, entries);
  return entry;
}

/**
 * Appends an entry to the undo ring WITHOUT clearing the redo stack. Used by
 * `dub redo` to make a successful redo immediately undoable again.
 */
export async function pushUndoEntryPreserveRedo(
  entry: UndoEntry,
  cwd: string,
): Promise<void> {
  await migrateLegacyEntry(cwd);
  const undoPath = await getUndoLogPath(cwd);
  const existing = readEntries(undoPath);
  existing.push(entry);
  while (existing.length > MAX_UNDO_ENTRIES) existing.shift();
  writeEntries(undoPath, existing);
}
