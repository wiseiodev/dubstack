import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { type BranchCommitMeta, getBranchCommitMetaBatch } from './git';
import { getStackOverviewPrBatch, type StackOverviewPrInfo } from './github';
import { getDubDir, readState } from './state';
import type { ReconcileSource } from './sync/types';

/** Cache TTL — kept short so users see CI / draft flips without `--refresh`. */
export const OVERVIEW_CACHE_TTL_MS = 30_000;

const CACHE_FILENAME = 'overview-cache.json';

/** Per-branch row in a {@link StackOverview}. */
export interface BranchOverview {
  branch: string;
  parent: string | null;
  /** True for the root branch (e.g. main) of its stack. */
  isRoot: boolean;
  /** GitHub PR snapshot, or `null` when no PR exists for this branch. */
  pr: StackOverviewPrInfo | null;
  /**
   * Local-tip commit metadata, or `null` when the branch ref does not exist
   * locally (never fetched / deleted). Branches that exist locally but are
   * not currently checked out still have metadata here.
   */
  commit: BranchCommitMeta | null;
  /** Dubstack-state mirror: PR URL (may exist before the PR is found via head). */
  prLink: string | null;
  lastSyncedAt: string | null;
  syncSource: ReconcileSource | null;
}

/** Full stack overview returned by {@link getStackOverviewBatch}. */
export interface StackOverview {
  /** All tracked branches across every stack, in state order. */
  branches: BranchOverview[];
  /**
   * True when `gh pr list` likely truncated (page-limit hit; the underlying
   * signal is a heuristic — exactly `BATCH_PR_LIST_LIMIT` PRs trips it even
   * when no further pages exist). Callers should surface a "showing N of
   * N+" notice — some branches may be missing PR data.
   */
  truncated: boolean;
  /** ISO timestamp when this snapshot was materialized. */
  cachedAt: string;
}

export interface GetStackOverviewOptions {
  /** When true, skip the on-disk cache and refetch. */
  refresh?: boolean;
  /** Test seam: override "now" for cache freshness checks. */
  now?: () => number;
}

async function getCachePath(cwd: string): Promise<string> {
  return path.join(await getDubDir(cwd), CACHE_FILENAME);
}

function isValidBranchOverview(value: unknown): value is BranchOverview {
  if (!value || typeof value !== 'object') return false;
  const b = value as Record<string, unknown>;
  return (
    typeof b.branch === 'string' &&
    (b.parent === null || typeof b.parent === 'string') &&
    typeof b.isRoot === 'boolean' &&
    (b.pr === null || (typeof b.pr === 'object' && b.pr !== null)) &&
    (b.commit === null || (typeof b.commit === 'object' && b.commit !== null))
  );
}

/**
 * Reads the persisted stack-overview cache if present and still within the
 * {@link OVERVIEW_CACHE_TTL_MS} window. Returns `null` on miss, corruption,
 * or stale data. Read-only — never refreshes or writes the cache.
 */
export async function readStackOverviewCache(
  cwd: string,
  now: number = Date.now(),
): Promise<StackOverview | null> {
  const cached = await readCache(cwd);
  if (!cached) return null;
  const cachedAtMs = Date.parse(cached.cachedAt);
  const age = now - cachedAtMs;
  if (!Number.isFinite(age) || age < 0 || age >= OVERVIEW_CACHE_TTL_MS) {
    return null;
  }
  return cached;
}

async function readCache(cwd: string): Promise<StackOverview | null> {
  let raw: string;
  try {
    raw = await fs.readFile(await getCachePath(cwd), 'utf-8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  // Defensive: cache lives at a user-visible path and may be hand-edited
  // or partially-truncated. Validate the whole shape, not just the top-
  // level keys, so callers never crash mid-render on a corrupted entry.
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;
  if (
    typeof p.cachedAt !== 'string' ||
    typeof p.truncated !== 'boolean' ||
    !Array.isArray(p.branches) ||
    !p.branches.every(isValidBranchOverview)
  ) {
    return null;
  }
  return p as unknown as StackOverview;
}

async function writeCache(cwd: string, overview: StackOverview): Promise<void> {
  const cachePath = await getCachePath(cwd);
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, `${JSON.stringify(overview, null, 2)}\n`);
}

/**
 * Builds the materialized stack overview used by `dub log`, `dub co`,
 * `dub status`, and `dub watch`. Issues **one** `gh pr list` and **one**
 * `git for-each-ref` regardless of stack size, joins them with Dubstack
 * state, and persists the result to `.git/dubstack/overview-cache.json`
 * with a {@link OVERVIEW_CACHE_TTL_MS} TTL.
 *
 * Pass `{ refresh: true }` from a `--refresh` flag to bust the cache.
 */
export async function getStackOverviewBatch(
  cwd: string,
  options: GetStackOverviewOptions = {},
): Promise<StackOverview> {
  const now = options.now?.() ?? Date.now();

  if (!options.refresh) {
    const cached = await readCache(cwd);
    if (cached) {
      const cachedAtMs = Date.parse(cached.cachedAt);
      const age = now - cachedAtMs;
      // Reject negative ages (clock skew) so a future-dated cache can't
      // pin us to stale data indefinitely.
      if (Number.isFinite(age) && age >= 0 && age < OVERVIEW_CACHE_TTL_MS) {
        return cached;
      }
    }
  }

  const state = await readState(cwd);
  const allBranchNames = state.stacks.flatMap((s) =>
    s.branches.map((b) => b.name),
  );

  // Short-circuit on fresh / empty state: no branches means nothing to
  // join, so skip the `gh pr list` (avoids spurious auth failures on a
  // freshly-initialized repo) and the for-each-ref call.
  if (allBranchNames.length === 0) {
    const empty: StackOverview = {
      branches: [],
      truncated: false,
      cachedAt: new Date(now).toISOString(),
    };
    try {
      await writeCache(cwd, empty);
    } catch {
      // best-effort
    }
    return empty;
  }

  const [prBatch, commitBatch] = await Promise.all([
    getStackOverviewPrBatch(cwd),
    getBranchCommitMetaBatch(cwd, allBranchNames),
  ]);

  const branches: BranchOverview[] = [];
  for (const stack of state.stacks) {
    for (const branch of stack.branches) {
      branches.push({
        branch: branch.name,
        parent: branch.parent,
        isRoot: branch.type === 'root',
        pr: prBatch.byBranch.get(branch.name) ?? null,
        commit: commitBatch.get(branch.name) ?? null,
        prLink: branch.pr_link ?? null,
        lastSyncedAt: branch.last_synced_at ?? null,
        syncSource: branch.sync_source ?? null,
      });
    }
  }

  const overview: StackOverview = {
    branches,
    truncated: prBatch.truncated,
    cachedAt: new Date(now).toISOString(),
  };

  // Best-effort: a read-only / full / corrupted .git dir must not crash
  // callers like `dub log` after we already paid for the fetch.
  try {
    await writeCache(cwd, overview);
  } catch {
    // Swallow: next call will simply refetch.
  }
  return overview;
}
