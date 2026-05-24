import { DubError } from './errors';

/**
 * A single entry in a git rebase --interactive todo file. `dub reorder` only
 * supports `pick` (keep the commit) and `drop` (skip it); the other rebase
 * verbs (`edit`, `squash`, `fixup`, `reword`) are deliberately out of scope —
 * use `dub modify --pop` and `dub squash` instead.
 */
export interface RebaseTodoEntry {
  /** Full commit SHA. Short SHAs work too, but full SHAs avoid ambiguity. */
  sha: string;
  /** Whether to keep (`pick`) or skip (`drop`) the commit. */
  action: 'pick' | 'drop';
  /** Optional commit subject; rendered as a trailing comment for readability. */
  subject?: string;
}

/**
 * Builds the body of a custom `git rebase --interactive` todo file from the
 * given ordered entries.
 *
 * The order of entries in the returned string is exactly the order git will
 * replay them — index 0 is the oldest commit (the one nearest the rebase
 * base), and the last entry is the newest. Callers reordering commits should
 * arrange the array accordingly.
 *
 * The string is newline-terminated so `git rebase` accepts it without
 * complaining about a missing trailing newline.
 *
 * @throws {DubError} If `entries` is empty (git rebase refuses an empty todo).
 */
export function buildRebaseTodo(entries: readonly RebaseTodoEntry[]): string {
  if (entries.length === 0) {
    throw new DubError('Cannot build an empty rebase todo.', [
      'Pass at least one entry; an empty todo aborts the rebase.',
    ]);
  }
  const lines = entries.map((entry) => {
    const subject = entry.subject?.trim();
    const suffix = subject ? ` ${subject}` : '';
    return `${entry.action} ${entry.sha}${suffix}`;
  });
  return `${lines.join('\n')}\n`;
}

/**
 * Returns true when the supplied entries describe a no-op reorder: every
 * commit kept in its original order with no drops. Used by `dub reorder` to
 * skip the rebase entirely when the picker exits unchanged.
 */
export function isNoopReorder(
  original: readonly string[],
  entries: readonly RebaseTodoEntry[],
): boolean {
  if (entries.length !== original.length) return false;
  if (entries.some((entry) => entry.action === 'drop')) return false;
  return entries.every((entry, idx) => entry.sha === original[idx]);
}
