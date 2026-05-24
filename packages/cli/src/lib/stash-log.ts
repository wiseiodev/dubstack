import * as fs from 'node:fs';
import * as path from 'node:path';
import { getDubDir } from './state';

/** One entry in the branch-aware stash log. */
export interface StashLogEntry {
  /** Commit SHA of the stash (`stash@{N}` resolves to this). Used to find the entry in `git stash list` after indexes shift. */
  sha: string;
  /** Branch the stash was created on. */
  branch: string;
  /** Stash message recorded by `git stash push -m`. */
  message: string;
  /** ISO timestamp the stash was recorded. */
  createdAt: string;
}

interface StashLogFile {
  version: 1;
  entries: StashLogEntry[];
}

/** Ring buffer cap. Older entries are dropped when this is exceeded. */
export const STASH_LOG_LIMIT = 50;

async function getStashLogPath(cwd: string): Promise<string> {
  const dubDir = await getDubDir(cwd);
  return path.join(dubDir, 'stash-log.json');
}

/**
 * Reads the stash log. Returns an empty list if the file is missing or
 * corrupt — the log is best-effort context, not authoritative state.
 */
export async function readStashLog(cwd: string): Promise<StashLogEntry[]> {
  const logPath = await getStashLogPath(cwd);
  if (!fs.existsSync(logPath)) return [];
  try {
    const raw = fs.readFileSync(logPath, 'utf-8');
    const parsed = JSON.parse(raw) as StashLogFile;
    if (!Array.isArray(parsed.entries)) return [];
    return parsed.entries.filter(isValidEntry);
  } catch {
    return [];
  }
}

/**
 * Writes the stash log atomically. Trims to the most recent
 * {@link STASH_LOG_LIMIT} entries.
 */
export async function writeStashLog(
  entries: StashLogEntry[],
  cwd: string,
): Promise<void> {
  const logPath = await getStashLogPath(cwd);
  const dir = path.dirname(logPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const trimmed = entries.slice(0, STASH_LOG_LIMIT);
  const payload: StashLogFile = { version: 1, entries: trimmed };
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  const tmpPath = `${logPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, serialized);
  try {
    fs.renameSync(tmpPath, logPath);
  } catch (error) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // best-effort cleanup
    }
    throw error;
  }
}

/** Prepends an entry to the log so most-recent is index 0. */
export async function prependStashLogEntry(
  entry: StashLogEntry,
  cwd: string,
): Promise<void> {
  const existing = await readStashLog(cwd);
  await writeStashLog([entry, ...existing], cwd);
}

/** Removes the first entry whose `sha` matches, if any. */
export async function removeStashLogEntry(
  sha: string,
  cwd: string,
): Promise<void> {
  const existing = await readStashLog(cwd);
  const idx = existing.findIndex((e) => e.sha === sha);
  if (idx === -1) return;
  const next = [...existing.slice(0, idx), ...existing.slice(idx + 1)];
  await writeStashLog(next, cwd);
}

function isValidEntry(value: unknown): value is StashLogEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.sha === 'string' &&
    typeof v.branch === 'string' &&
    typeof v.message === 'string' &&
    typeof v.createdAt === 'string'
  );
}
