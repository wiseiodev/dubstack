import * as fs from 'node:fs';
import * as path from 'node:path';
import { getDubDir } from './state';

export interface CheckoutEntry {
  branch: string;
  at: string;
  via: string;
}

interface StoredCheckoutEntry extends CheckoutEntry {
  transient?: boolean;
}

export interface PopCheckoutHistoryResult {
  target: CheckoutEntry | null;
  skipped: CheckoutEntry[];
  popped: CheckoutEntry[];
}

const MAX_SIZE = 20;
const DEFAULT_READ_LIMIT = MAX_SIZE;

export async function getCheckoutHistoryPath(cwd: string): Promise<string> {
  const dir = await getDubDir(cwd);
  return path.join(dir, 'checkout-history.json');
}

async function readStored(cwd: string): Promise<StoredCheckoutEntry[]> {
  const target = await getCheckoutHistoryPath(cwd);
  if (!fs.existsSync(target)) return [];
  try {
    const raw = fs.readFileSync(target, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry): entry is Record<string, unknown> =>
          entry !== null &&
          typeof entry === 'object' &&
          typeof (entry as Record<string, unknown>).branch === 'string' &&
          typeof (entry as Record<string, unknown>).at === 'string' &&
          typeof (entry as Record<string, unknown>).via === 'string',
      )
      .map((entry) => {
        const stored: StoredCheckoutEntry = {
          branch: entry.branch as string,
          at: entry.at as string,
          via: entry.via as string,
        };
        // Only treat a strict boolean `true` as transient. Any other value
        // (string, number, missing) is normalized to a non-transient entry
        // so corruption can never silently hide history from a default read.
        if (entry.transient === true) stored.transient = true;
        return stored;
      });
  } catch {
    return [];
  }
}

async function writeStored(
  cwd: string,
  entries: StoredCheckoutEntry[],
): Promise<void> {
  const target = await getCheckoutHistoryPath(cwd);
  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // Atomic write-rename prevents torn writes, but two concurrent dub
  // processes can still lose an entry via last-writer-wins. DUB-60's
  // lockfile will close that gap; until then, the loss is acceptable
  // for a non-critical history log.
  const payload = `${JSON.stringify(entries, null, 2)}\n`;
  const tmpPath = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, payload);
  try {
    fs.renameSync(tmpPath, target);
  } catch (error) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // best-effort cleanup; surface the original rename error
    }
    throw error;
  }
}

/**
 * Appends a checkout entry to the ring buffer at `.git/dubstack/checkout-history.json`.
 * Older entries beyond `MAX_SIZE` are dropped silently.
 *
 * Failures are swallowed: this is an auxiliary log and must never break the
 * checkout that just succeeded.
 */
export async function appendCheckoutHistory(
  cwd: string,
  branch: string,
  opts: { via: string; transient?: boolean },
): Promise<void> {
  try {
    const entries = await readStored(cwd);
    const entry: StoredCheckoutEntry = {
      branch,
      at: new Date().toISOString(),
      via: opts.via,
    };
    if (opts.transient) entry.transient = true;
    entries.push(entry);
    const trimmed =
      entries.length > MAX_SIZE ? entries.slice(-MAX_SIZE) : entries;
    await writeStored(cwd, trimmed);
  } catch {
    // best-effort; never let history failures break a checkout
  }
}

/**
 * Reads checkout history, newest first.
 * Entries marked `transient: true` are filtered from the result.
 */
export async function readCheckoutHistory(
  cwd: string,
  limit: number = DEFAULT_READ_LIMIT,
): Promise<CheckoutEntry[]> {
  if (limit <= 0) return [];
  const entries = await readStored(cwd);
  const visible = entries.filter((entry) => !entry.transient);
  return visible
    .slice(-limit)
    .reverse()
    .map(({ branch, at, via }) => ({ branch, at, via }));
}

/**
 * Pops visible checkout-history entries until `steps` existing branches have
 * been consumed, then checks out the final target and persists the shortened
 * history. The current branch can appear as the newest visit because history
 * records destinations; leading current-branch entries are discarded before
 * counting back.
 */
export async function popCheckoutHistory(
  cwd: string,
  steps: number,
  opts: {
    currentBranch?: string | null;
    branchExists: (branch: string) => Promise<boolean>;
    checkoutBranch: (branch: string) => Promise<void>;
  },
): Promise<PopCheckoutHistoryResult> {
  if (steps <= 0) {
    return { target: null, skipped: [], popped: [] };
  }

  const entries = await readStored(cwd);
  const removeIndexes = new Set<number>();
  const skipped: CheckoutEntry[] = [];
  const popped: CheckoutEntry[] = [];
  let remainingSteps = steps;
  let target: CheckoutEntry | null = null;
  let onlySeenLeadingCurrent = true;

  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.transient) continue;

    if (
      onlySeenLeadingCurrent &&
      opts.currentBranch &&
      entry.branch === opts.currentBranch
    ) {
      removeIndexes.add(index);
      continue;
    }

    onlySeenLeadingCurrent = false;
    removeIndexes.add(index);

    if (!(await opts.branchExists(entry.branch))) {
      skipped.push(entry);
      continue;
    }

    popped.push(entry);
    remainingSteps--;
    if (remainingSteps === 0) {
      target = entry;
      break;
    }
  }

  if (!target) {
    return { target: null, skipped, popped };
  }

  await opts.checkoutBranch(target.branch);
  await writeStored(
    cwd,
    entries.filter((_, index) => !removeIndexes.has(index)),
  );

  return { target, skipped, popped };
}

export async function clearCheckoutHistory(cwd: string): Promise<void> {
  const target = await getCheckoutHistoryPath(cwd);
  if (fs.existsSync(target)) {
    fs.unlinkSync(target);
  }
}
