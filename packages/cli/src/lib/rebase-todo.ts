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
 * @throws {Error} If `entries` is empty. This is a developer invariant, not
 * a user-facing failure — `dub reorder` validates "all entries dropped" /
 * "no commits to reorder" *before* calling this helper and surfaces those
 * via `DubError`.
 */
export function buildRebaseTodo(entries: readonly RebaseTodoEntry[]): string {
  if (entries.length === 0) {
    throw new Error('buildRebaseTodo: entries must be non-empty.');
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
 *
 * The length guard is defence-in-depth: in production, `dub reorder` always
 * passes `entries` of the same length as `original` (drops are represented
 * as `action: 'drop'` rather than absent entries), but a future caller or
 * test that hands in a shorter list will correctly be treated as "not a
 * no-op" so the rebase still runs.
 */
export function isNoopReorder(
  original: readonly string[],
  entries: readonly RebaseTodoEntry[],
): boolean {
  if (entries.length !== original.length) return false;
  if (entries.some((entry) => entry.action === 'drop')) return false;
  return entries.every((entry, idx) => entry.sha === original[idx]);
}
