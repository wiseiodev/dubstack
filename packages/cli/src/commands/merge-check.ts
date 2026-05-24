import { DubError } from '../lib/errors';
import { getCurrentBranch } from '../lib/git';
import {
  checkGhAuth,
  ensureGhInstalled,
  getPr,
  getPrByNumber,
  getPrMergeStatusByNumber,
  getPrStateByNumber,
  type PrInfo,
} from '../lib/github';
import { parseDubstackMetadata } from '../lib/pr-body';
import { resolveScopeBranches, type ScopeMode } from '../lib/scope';
import { findStackForBranch, readState } from '../lib/state';

export interface MergeCheckBranchFinding {
  branch: string;
  prNumber: number | null;
  ok: boolean;
  reason: string;
  /** Remediation hints (only populated when ok=false). */
  fixes: string[];
}

export interface MergeCheckResult {
  ok: boolean;
  scope: ScopeMode;
  /** First branch's PR number; preserved for the single-PR case. */
  prNumber: number | null;
  /** First branch's reason; preserved for the single-PR case. */
  reason: string;
  branches: MergeCheckBranchFinding[];
}

const SAFE_MERGE_STATE_STATUSES = new Set(['CLEAN', 'HAS_HOOKS']);

export async function mergeCheck(
  cwd: string,
  options: { pr?: number; branch?: string; scope?: ScopeMode } = {},
): Promise<MergeCheckResult> {
  await ensureGhInstalled();
  await checkGhAuth();

  // Explicit --pr forces single-PR mode regardless of scope.
  if (options.pr != null) {
    const pr = await getPrByNumber(options.pr, cwd);
    const finding = await checkPrFinding(`pr-${options.pr}`, pr, cwd);
    throwIfAnyFailed([finding]);
    return {
      ok: true,
      scope: 'current',
      prNumber: finding.prNumber,
      reason: finding.reason,
      branches: [finding],
    };
  }

  const scope = options.scope ?? 'current';

  // For single-branch / explicit branch mode without scope walking.
  if (options.branch != null || scope === 'current') {
    const branchName = options.branch ?? (await getCurrentBranch(cwd));
    const pr = await getPr(branchName, cwd);
    const finding = await checkPrFinding(branchName, pr, cwd);
    throwIfAnyFailed([finding]);
    return {
      ok: true,
      scope: 'current',
      prNumber: finding.prNumber,
      reason: finding.reason,
      branches: [finding],
    };
  }

  // Scope walks multiple branches in the stack.
  const currentBranch = await getCurrentBranch(cwd);
  const state = await readState(cwd);
  const stack = findStackForBranch(state, currentBranch);
  if (!stack) {
    throw new DubError(`Branch '${currentBranch}' is not part of any stack.`, [
      "Run 'dub track <branch> --parent <branch>' to track this branch.",
      "Run 'dub merge-check --branch <branch>' to check a single branch by name.",
    ]);
  }

  const scopedBranches = resolveScopeBranches(stack, currentBranch, scope);
  if (scopedBranches.length === 0) {
    throw new DubError(
      `No mergeable branches in scope '${scope}' for '${currentBranch}'.`,
      [
        "Run 'dub checkout <branch>' to move off a root/trunk branch.",
        "Run 'dub merge-check --scope current' to check just this branch.",
      ],
    );
  }

  const findings: MergeCheckBranchFinding[] = [];
  for (const branch of scopedBranches) {
    const pr = await getPr(branch.name, cwd);
    findings.push(await checkPrFinding(branch.name, pr, cwd));
  }
  throwIfAnyFailed(findings);

  const [first] = findings;
  return {
    ok: true,
    scope,
    prNumber: first?.prNumber ?? null,
    reason:
      findings.length === 1
        ? (first?.reason ?? '')
        : `${findings.length} branch(es) checked; merge order satisfied.`,
    branches: findings,
  };
}

async function checkPrFinding(
  branchLabel: string,
  pr: PrInfo | null,
  cwd: string,
): Promise<MergeCheckBranchFinding> {
  if (!pr) {
    return {
      branch: branchLabel,
      prNumber: null,
      ok: true,
      reason: 'No open PR found. Merge-order check skipped.',
      fixes: [],
    };
  }

  const metadata = parseDubstackMetadata(pr.body);
  if (!metadata) {
    return {
      branch: branchLabel,
      prNumber: pr.number,
      ok: true,
      reason: 'No DubStack metadata found. Merge-order check skipped.',
      fixes: [],
    };
  }

  if (metadata.prev_pr == null) {
    return {
      branch: branchLabel,
      prNumber: pr.number,
      ok: true,
      reason: 'Root stack PR: merge order satisfied.',
      fixes: [],
    };
  }

  const previousState = await getPrStateByNumber(metadata.prev_pr, cwd);
  if (previousState !== 'MERGED') {
    return {
      branch: branchLabel,
      prNumber: pr.number,
      ok: false,
      reason: `PR #${pr.number} cannot be merged yet. Previous stack PR #${metadata.prev_pr} is '${previousState}'.`,
      fixes: [
        `Run 'dub merge-next --pr ${metadata.prev_pr}' to merge the previous PR first.`,
        `Run 'gh pr view ${metadata.prev_pr}' to inspect the previous PR's status.`,
      ],
    };
  }

  const mergeStatus = await getPrMergeStatusByNumber(pr.number, cwd);
  const mergeable = mergeStatus.mergeable ?? 'unknown';
  const mergeStateStatus = mergeStatus.mergeStateStatus ?? 'unknown';
  const safelyMergeable =
    mergeable === 'MERGEABLE' &&
    SAFE_MERGE_STATE_STATUSES.has(mergeStateStatus);
  if (!safelyMergeable) {
    return {
      branch: branchLabel,
      prNumber: pr.number,
      ok: false,
      reason: `PR #${pr.number} is not mergeable on GitHub. GitHub reports mergeable='${mergeable}' and mergeStateStatus='${mergeStateStatus}'.`,
      fixes: [
        `Run 'gh pr view ${pr.number} --web' to inspect required checks and reviews.`,
        "Run 'dub sync' to reconcile remote drift, then 'dub submit' to refresh the PR.",
        'Retry once required checks pass.',
      ],
    };
  }

  return {
    branch: branchLabel,
    prNumber: pr.number,
    ok: true,
    reason: `Previous stack PR #${metadata.prev_pr} is merged; merge order satisfied.`,
    fixes: [],
  };
}

function throwIfAnyFailed(findings: MergeCheckBranchFinding[]): void {
  const failed = findings.filter((f) => !f.ok);
  if (failed.length === 0) return;

  // Preserve the single-PR DubError shape (reason + fixes) whenever exactly one
  // branch fails, regardless of how many branches were inspected. This keeps the
  // recovery hints attached to the offending PR rather than flattening them into
  // an aggregated summary.
  if (failed.length === 1) {
    const [only] = failed;
    if (!only) return;
    throw new DubError(only.reason, only.fixes);
  }

  const summary = failed.map((f) => `• ${f.branch}: ${f.reason}`).join('\n');
  const fixes = Array.from(new Set(failed.flatMap((f) => f.fixes)));
  throw new DubError(
    `${failed.length} of ${findings.length} branch(es) cannot merge yet:\n${summary}`,
    fixes,
  );
}
