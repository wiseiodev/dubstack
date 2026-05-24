import { getCurrentBranch } from '../lib/git';
import type {
  BranchPrLifecycleState,
  CiStatusRollup,
  StackOverviewPrInfo,
} from '../lib/github';
import {
  type ActiveOperation,
  detectActiveOperation,
} from '../lib/operation-state';
import {
  getStackOverviewBatch,
  readStackOverviewCache,
} from '../lib/stack-overview';
import { branchInfo } from './branch';
import { type DoctorIssue, doctor } from './doctor';

export interface BranchSnapshot {
  tracked: boolean;
  stackId: string | null;
  root: string | null;
  parent: string | null;
  children: string[];
}

export interface PrSnapshot {
  // `'UNKNOWN'` is reserved for future caller-supplied failure cases; the
  // current cached/live/cold paths never produce it.
  state: BranchPrLifecycleState | 'UNKNOWN';
  baseRefName: string | null;
  number: number | null;
  title: string | null;
  isDraft: boolean | null;
  ciRollup: CiStatusRollup | null;
  reviewDecision: string | null;
}

export interface DriftSnapshot {
  healthy: boolean;
  issues: DoctorIssue[];
}

export interface StatusResult {
  schemaVersion: 1;
  cached: boolean;
  // `getCurrentBranch` throws DubError on detached HEAD, so callers always
  // receive a resolved branch name here.
  currentBranch: string;
  operation: ActiveOperation;
  branch: BranchSnapshot;
  // `null` when --no-pr is set or on a cold cache-only read.
  pr: PrSnapshot | null;
  // `null` on a cold cache-only read (skipped to keep p99 under 100ms).
  drift: DriftSnapshot | null;
}

export interface StatusOptions {
  /** Bypass the overview cache and force a fresh batched gh fetch. */
  live?: boolean;
  /** Include PR data (default true). Pass false for `--no-pr`. */
  pr?: boolean;
}

/**
 * Returns a structured snapshot of the current branch's stack tracking, active
 * operation, PR lifecycle, and drift health. Shared by the `dubstack.status`
 * MCP tool and the `dub status` CLI command.
 *
 * Modes:
 * - `{ live: true }`: refresh the stack-overview cache via a single batched
 *   `gh pr list`, then build a full snapshot. `cached: false`.
 * - default (`{ live: false }`): read the overview cache if fresh and use it
 *   for PR data. `cached: true`. Falls back to cold local-only when the cache
 *   is missing or stale — no `gh` calls and no drift checks. `cached: false`.
 * - `{ pr: false }`: never call `gh`, even with `live: true`. Returns
 *   `pr: null`. Drift is still computed when a fresh-enough overview cache is
 *   present (drift checks are local-only).
 */
export async function status(
  cwd: string,
  options: StatusOptions = {},
): Promise<StatusResult> {
  const includePr = options.pr !== false;
  const currentBranch = await getCurrentBranch(cwd);
  const info = await branchInfo(cwd, currentBranch);
  const operation = await detectActiveOperation(cwd);
  const branchSnapshot: BranchSnapshot = {
    tracked: info.tracked,
    stackId: info.stackId,
    root: info.root,
    parent: info.parent,
    children: info.children,
  };

  // `pr: false` is the no-network contract. It overrides `live: true` so
  // `dub status --no-pr --live` cannot trigger a `gh pr list` batch fetch —
  // `--live` only makes sense when the caller actually wants fresh PR data.
  if (options.live && includePr) {
    const overview = await getStackOverviewBatch(cwd, { refresh: true });
    const pr = buildPrSnapshotFromOverview(overview.branches, currentBranch);
    const drift = await computeDrift(cwd);
    return {
      schemaVersion: 1,
      cached: false,
      currentBranch,
      operation,
      branch: branchSnapshot,
      pr,
      drift,
    };
  }

  const cached = await readStackOverviewCache(cwd);
  if (cached) {
    const pr = includePr
      ? buildPrSnapshotFromOverview(cached.branches, currentBranch)
      : null;
    const drift = await computeDrift(cwd);
    return {
      schemaVersion: 1,
      cached: true,
      currentBranch,
      operation,
      branch: branchSnapshot,
      pr,
      drift,
    };
  }

  // Cold path: no cache and not --live. Never touches the network — keeps
  // cache-miss reads under the 100ms target for shell prompts. Callers that
  // need PR data on cold reads should pass `--live`.
  return {
    schemaVersion: 1,
    cached: false,
    currentBranch,
    operation,
    branch: branchSnapshot,
    pr: null,
    drift: null,
  };
}

async function computeDrift(cwd: string): Promise<DriftSnapshot> {
  // Local-only drift: no network fetch and no per-branch `gh pr list`.
  // Keeps cache-only `dub status` under the 100ms target.
  const health = await doctor(cwd, {
    all: false,
    fetch: false,
    skipGithub: true,
  });
  const issues = health.issues.filter(isDriftIssue);
  return { healthy: issues.length === 0, issues };
}

function buildPrSnapshotFromOverview(
  branches: { branch: string; pr: StackOverviewPrInfo | null }[],
  currentBranch: string,
): PrSnapshot {
  const entry = branches.find((b) => b.branch === currentBranch);
  const pr = entry?.pr ?? null;
  if (!pr) {
    return {
      state: 'NONE',
      baseRefName: null,
      number: null,
      title: null,
      isDraft: null,
      ciRollup: null,
      reviewDecision: null,
    };
  }
  return {
    state: pr.state,
    baseRefName: pr.baseRefName,
    number: pr.number,
    title: pr.title,
    isDraft: pr.isDraft,
    ciRollup: pr.ciRollup,
    reviewDecision: pr.reviewDecision,
  };
}

export function isDriftIssue(issue: DoctorIssue): boolean {
  return (
    issue.code === 'parent-mismatch' ||
    issue.code === 'remote-base-mismatch' ||
    issue.code === 'missing-local' ||
    issue.code === 'missing-remote' ||
    issue.code === 'remote-drift' ||
    issue.code === 'remote-check-failed'
  );
}

/**
 * Human-readable one-liner derived from a {@link StatusResult}. Intended for
 * shell prompts and tmux/status bars. Example outputs:
 *
 *   feat/api · PR #123 OPEN · CI SUCCESS · ✓
 *   feat/loose · no PR · ✓
 *   feat/api · PR #123 OPEN · CI ⏳ · ⚠ 2 drift issue(s)
 *   feat/api · (cold)
 */
export function formatStatus(result: StatusResult): string {
  const parts: string[] = [result.currentBranch];

  if (result.operation !== 'none') {
    parts.push(`${result.operation} in progress`);
  }

  if (result.pr) {
    if (result.pr.number != null) {
      const label = result.pr.isDraft ? 'DRAFT' : result.pr.state;
      parts.push(`PR #${result.pr.number} ${label}`);
    } else if (result.pr.state !== 'NONE') {
      parts.push(`PR ${result.pr.state}`);
    } else {
      parts.push('no PR');
    }
    if (result.pr.ciRollup && result.pr.ciRollup !== 'NONE') {
      parts.push(`CI ${formatCi(result.pr.ciRollup)}`);
    }
  } else if (result.cached === false && result.drift === null) {
    parts.push('(cold)');
  }

  if (result.drift) {
    if (result.drift.healthy) {
      parts.push('✓');
    } else {
      parts.push(`⚠ ${result.drift.issues.length} drift issue(s)`);
    }
  }

  return parts.join(' · ');
}

function formatCi(rollup: CiStatusRollup): string {
  switch (rollup) {
    case 'SUCCESS':
      return 'SUCCESS';
    case 'FAILURE':
      return 'FAILURE';
    case 'PENDING':
      return '⏳';
    case 'NONE':
      return 'NONE';
  }
}
