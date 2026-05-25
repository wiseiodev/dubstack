import { openUrl } from './browser';
import { DubError } from './errors';
import { execa, type Options } from './exec';
import { type RetryOptions, retry } from './retry';
import { writeTempMarkdownFile } from './temp-text-file';

/** Details of a GitHub Pull Request. */
export interface PrInfo {
  number: number;
  url: string;
  title: string;
  body: string;
}

export type BranchPrLifecycleState = 'OPEN' | 'CLOSED' | 'MERGED' | 'NONE';

export interface BranchPrSyncInfo {
  state: BranchPrLifecycleState;
  baseRefName: string | null;
}

export interface AllPrSyncInfoBatch {
  /** Map keyed by `headRefName` (branch). */
  byBranch: Map<string, BranchPrSyncInfo>;
  /**
   * True when `gh pr list` likely truncated results (page-limit hit).
   * Callers should fall back to `getBranchPrSyncInfo` for any branch
   * missing from `byBranch`.
   */
  truncated: boolean;
}

/** Page limit for the batched `gh pr list` call. */
const BATCH_PR_LIST_LIMIT = 100;

export interface PrMergeStatus {
  mergeable: string | null;
  mergeStateStatus: string | null;
}

export type MergeMethod = 'merge' | 'squash' | 'rebase';

export interface EnableAutoMergeResult {
  method: MergeMethod;
}

export interface PrCreateWebInput {
  branch: string;
  base: string;
  title: string;
  body: string;
}

export interface PrCreateWebResult {
  url: string;
  bodyIncluded: boolean;
  bodyFilePath: string | null;
}

let ghRetryOverrides: Partial<RetryOptions> = {};

const WEB_PR_BODY_URL_LIMIT = 4000;

/**
 * Test-only seam: overrides retry options applied to every `gh` call wrapped
 * by {@link runGh}. Tests use this to disable backoff sleeps and jitter so
 * retry behavior can be exercised without wall-clock waits.
 */
export function __setGhRetryOptionsForTesting(
  opts: Partial<RetryOptions>,
): void {
  ghRetryOverrides = opts;
}

/**
 * Classifies a `gh`-call error as permanent (do not retry). Covers HTTP
 * 401/403/404 (only when the digits appear in an explicit HTTP/status
 * context), the GraphQL "could not resolve to a pull request" variants,
 * `no pull requests found`, and `ENOENT` (gh binary missing).
 *
 * The bare `not found` substring is intentionally *not* matched here even
 * though `isPrNotFoundError` accepts it — OS-level and DNS errors can
 * include `not found` (e.g. `host not found`) and we want those to retry.
 * The HTTP-status regex below is similarly scoped: bare `401`/`403`/`404`
 * digits in branch names or command args echoed inside error stderr would
 * otherwise spuriously short-circuit retries.
 */
function isPermanentGhError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const normalized = message.toLowerCase();
  // Require an explicit HTTP/status prefix or status-phrase suffix so we
  // don't false-positive on the digits appearing in branch names or args.
  if (
    /\b(?:HTTP|status(?:\s+code)?)\s*:?\s*(?:401|403|404)\b/i.test(message) ||
    /\b401\s+unauthorized\b/i.test(message) ||
    /\b403\s+(?:forbidden|insufficient)\b/i.test(message) ||
    /\b404\s+not\s+found\b/i.test(message)
  ) {
    return true;
  }
  if (normalized.includes('could not resolve to a pull request')) return true;
  if (normalized.includes('could not resolve to a pullrequest')) return true;
  if (normalized.includes('no pull requests found')) return true;
  if (normalized.includes('enoent')) return true;
  if (isMergeMethodUnavailable(message)) return true;
  if (isAutoMergeSetupUnavailable(message)) return true;
  return false;
}

/**
 * Runs `gh` with retry + exponential backoff. Permanent errors short-circuit
 * via {@link isPermanentGhError}; other errors retry up to the configured
 * limit (default 4 attempts). Stdout/stderr are normalized to strings — the
 * call sites that read stdout never pass binary encodings, and `stdio:
 * 'inherit'` callers ignore the return value.
 */
async function runGh(
  args: string[],
  options: Options = {},
): Promise<{ stdout: string; stderr: string }> {
  const result = await retry(() => execa('gh', args, options), {
    isPermanent: isPermanentGhError,
    ...ghRetryOverrides,
  });
  return {
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
  };
}

/**
 * Unwraps the original error from a {@link retry} exhaustion wrapper so
 * downstream classifiers (e.g. {@link isPrNotFoundError}) and DubError
 * messages reflect the underlying cause. Unwraps recursively because a
 * nested gh call (e.g. createPr's idempotency check) can produce a
 * wrapper-of-wrapper chain.
 */
function unwrapRetryError(err: unknown): unknown {
  let current: unknown = err;
  while (
    current instanceof Error &&
    current.cause !== undefined &&
    current.message.startsWith('retry: giving up')
  ) {
    current = current.cause;
  }
  return current;
}

/**
 * Ensures the `gh` CLI is installed and available in PATH.
 * @throws {DubError} If `gh` is not found.
 */
export async function ensureGhInstalled(): Promise<void> {
  try {
    await runGh(['--version']);
  } catch {
    throw new DubError('gh CLI not found.', [
      'Install the GitHub CLI from https://cli.github.com.',
      "Run 'gh --version' to confirm installation, then retry.",
    ]);
  }
}

/**
 * Ensures the user is authenticated with `gh`.
 * @throws {DubError} If not authenticated.
 */
export async function checkGhAuth(): Promise<void> {
  try {
    await runGh(['auth', 'status']);
  } catch {
    throw new DubError('Not authenticated with GitHub.', [
      "Run 'gh auth login' and sign in with the 'repo' scope.",
      "Run 'gh auth status' to confirm authentication, then retry.",
    ]);
  }
}

/**
 * Fetches the open PR for a given head branch, if one exists.
 * @returns The PR info, or `null` if no open PR exists for that branch.
 */
export async function getPr(
  branch: string,
  cwd: string,
): Promise<PrInfo | null> {
  const { stdout } = await runGh(
    [
      'pr',
      'list',
      '--head',
      branch,
      '--state',
      'open',
      '--json',
      'number,url,title,body',
      '--jq',
      '.[0]',
    ],
    { cwd },
  );

  const trimmed = stdout.trim();
  if (!trimmed || trimmed === 'null') return null;

  try {
    return JSON.parse(trimmed) as PrInfo;
  } catch {
    throw new DubError(`Failed to parse PR info for branch '${branch}'.`, [
      `Run 'gh pr list --head ${branch}' to inspect the raw response.`,
      'Retry once GitHub is healthy if the response is partial.',
    ]);
  }
}

/**
 * Fetches PR info by number.
 * @returns The PR info, or null if not found.
 */
export async function getPrByNumber(
  prNumber: number,
  cwd: string,
): Promise<PrInfo | null> {
  let stdout: string;
  try {
    const result = await runGh(
      [
        'pr',
        'view',
        String(prNumber),
        '--json',
        'number,url,title,body',
        '--jq',
        '.',
      ],
      { cwd },
    );
    stdout = result.stdout;
  } catch (error) {
    const root = unwrapRetryError(error);
    if (isPrNotFoundError(root)) return null;
    const message = root instanceof Error ? root.message : String(root);
    throw new DubError(`Failed to fetch PR #${prNumber}: ${message}`, [
      `Run 'gh pr view ${prNumber}' to confirm the PR exists.`,
      "Run 'gh auth status' to verify authentication, then retry.",
    ]);
  }
  const trimmed = stdout.trim();
  if (!trimmed || trimmed === 'null') return null;
  try {
    return JSON.parse(trimmed) as PrInfo;
  } catch {
    throw new DubError(`Failed to parse PR #${prNumber}.`, [
      `Run 'gh pr view ${prNumber} --json number,url,title,body' to inspect the response.`,
      'Retry once GitHub is healthy.',
    ]);
  }
}

/**
 * Returns coarse lifecycle state of a PR associated with the branch head.
 */
export async function getBranchPrLifecycleState(
  branch: string,
  cwd: string,
): Promise<BranchPrLifecycleState> {
  const info = await getBranchPrSyncInfo(branch, cwd);
  return info.state;
}

/**
 * Returns PR lifecycle and base branch information for sync decisions.
 */
export async function getBranchPrSyncInfo(
  branch: string,
  cwd: string,
): Promise<BranchPrSyncInfo> {
  const { stdout } = await runGh(
    [
      'pr',
      'list',
      '--head',
      branch,
      '--state',
      'all',
      '--json',
      'state,mergedAt,baseRefName',
      '--jq',
      '.[0]',
    ],
    { cwd },
  );

  const trimmed = stdout.trim();
  if (!trimmed || trimmed === 'null') {
    return { state: 'NONE', baseRefName: null };
  }

  try {
    const parsed = JSON.parse(trimmed) as {
      state?: string;
      mergedAt?: string | null;
      baseRefName?: string | null;
    };
    if (parsed.mergedAt) {
      return {
        state: 'MERGED',
        baseRefName: parsed.baseRefName ?? null,
      };
    }
    if (parsed.state === 'CLOSED') {
      return {
        state: 'CLOSED',
        baseRefName: parsed.baseRefName ?? null,
      };
    }
    if (parsed.state === 'OPEN') {
      return {
        state: 'OPEN',
        baseRefName: parsed.baseRefName ?? null,
      };
    }
    return { state: 'NONE', baseRefName: parsed.baseRefName ?? null };
  } catch {
    throw new DubError(
      `Failed to parse PR lifecycle state for branch '${branch}'.`,
      [
        `Run 'gh pr list --head ${branch}' to inspect the raw response.`,
        'Retry once GitHub is healthy.',
      ],
    );
  }
}

/**
 * Fetches PR sync info for all open + recent merged/closed PRs in one `gh` call.
 *
 * Replaces N per-branch `gh pr list --head <branch>` round-trips with a single
 * batched query. Callers join in memory by `headRefName`.
 *
 * Returns `truncated: true` when the page limit was hit, signaling that
 * branches missing from the map may still have PRs and should fall back to
 * `getBranchPrSyncInfo`.
 */
export async function getAllPrSyncInfoBatch(
  cwd: string,
): Promise<AllPrSyncInfoBatch> {
  let stdout: string;
  try {
    const result = await runGh(
      [
        'pr',
        'list',
        '--state',
        'all',
        '--json',
        'headRefName,baseRefName,state,mergedAt',
        '--limit',
        String(BATCH_PR_LIST_LIMIT),
      ],
      { cwd },
    );
    stdout = result.stdout;
  } catch (error) {
    const root = unwrapRetryError(error);
    const message = root instanceof Error ? root.message : String(root);
    throw new DubError(`Failed to list PRs: ${message}`, [
      "Run 'gh pr list --state all' manually to inspect the failure.",
      "Run 'gh auth status' to verify authentication, then retry.",
    ]);
  }

  const trimmed = stdout.trim();
  const byBranch = new Map<string, BranchPrSyncInfo>();
  if (!trimmed || trimmed === 'null') {
    return { byBranch, truncated: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new DubError('Failed to parse batched PR list response.', [
      "Run 'gh pr list --state all --json state' to inspect the raw response.",
      'Retry once GitHub is healthy.',
    ]);
  }
  if (!Array.isArray(parsed)) {
    return { byBranch, truncated: false };
  }

  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as {
      headRefName?: string;
      baseRefName?: string | null;
      state?: string;
      mergedAt?: string | null;
    };
    const head = record.headRefName;
    if (!head) continue;
    // First PR per branch wins. gh sorts newest first, so this prefers the
    // most recent PR — matching getBranchPrSyncInfo's `.[0]` semantics.
    if (byBranch.has(head)) continue;
    byBranch.set(head, {
      state: classifyPrState(record.state, record.mergedAt),
      baseRefName: record.baseRefName ?? null,
    });
  }

  // Use the raw response length, not byBranch.size: when the list is truncated,
  // some branches may be entirely absent (all their PRs were older than the
  // limit). Sizing on unique branches would create false negatives — fallback
  // would never fire for those missing branches.
  return { byBranch, truncated: parsed.length >= BATCH_PR_LIST_LIMIT };
}

function classifyPrState(
  state: string | undefined,
  mergedAt: string | null | undefined,
): BranchPrLifecycleState {
  if (mergedAt) return 'MERGED';
  if (state === 'CLOSED') return 'CLOSED';
  if (state === 'OPEN') return 'OPEN';
  return 'NONE';
}

/** Rolled-up CI state across all checks on a PR's head commit. */
export type CiStatusRollup = 'SUCCESS' | 'FAILURE' | 'PENDING' | 'NONE';

/**
 * Per-branch PR snapshot used by the stack overview pipeline. Richer than
 * {@link BranchPrSyncInfo} — adds title, draft, review decision, and a
 * rolled-up CI status so `dub log` / `dub co` / `dub status` can render
 * the whole stack from one batched call.
 */
export interface StackOverviewPrInfo {
  number: number;
  title: string;
  state: BranchPrLifecycleState;
  baseRefName: string | null;
  mergedAt: string | null;
  /** `APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED`, or null. */
  reviewDecision: string | null;
  ciRollup: CiStatusRollup;
  isDraft: boolean;
}

export interface StackOverviewPrBatch {
  byBranch: Map<string, StackOverviewPrInfo>;
  /** True when `gh pr list` likely truncated results (page-limit hit). */
  truncated: boolean;
}

/**
 * Batched, richer cousin of {@link getAllPrSyncInfoBatch} for the stack
 * overview pipeline. One `gh pr list` call returns title, draft, review
 * decision, and `statusCheckRollup` per PR; this helper rolls the latter
 * up to a single {@link CiStatusRollup}.
 *
 * Kept separate from {@link getAllPrSyncInfoBatch} so sync — which only
 * needs `{state, baseRefName}` — doesn't pay the wider `--json` cost and
 * its existing parser tests stay untouched.
 */
export async function getStackOverviewPrBatch(
  cwd: string,
): Promise<StackOverviewPrBatch> {
  let stdout: string;
  try {
    const result = await runGh(
      [
        'pr',
        'list',
        '--state',
        'all',
        '--json',
        'number,title,headRefName,baseRefName,state,mergedAt,reviewDecision,statusCheckRollup,isDraft',
        '--limit',
        String(BATCH_PR_LIST_LIMIT),
      ],
      { cwd },
    );
    stdout = result.stdout;
  } catch (error) {
    const root = unwrapRetryError(error);
    const message = root instanceof Error ? root.message : String(root);
    throw new DubError(`Failed to list PRs: ${message}`, [
      "Run 'gh pr list --state all' manually to inspect the failure.",
      "Run 'gh auth status' to verify authentication, then retry.",
    ]);
  }

  const trimmed = stdout.trim();
  const byBranch = new Map<string, StackOverviewPrInfo>();
  if (!trimmed || trimmed === 'null') {
    return { byBranch, truncated: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new DubError('Failed to parse batched PR list response.', [
      "Run 'gh pr list --state all --json state' to inspect the raw response.",
      'Retry once GitHub is healthy.',
    ]);
  }
  if (!Array.isArray(parsed)) {
    return { byBranch, truncated: false };
  }

  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as {
      number?: number;
      title?: string;
      headRefName?: string;
      baseRefName?: string | null;
      state?: string;
      mergedAt?: string | null;
      reviewDecision?: string | null;
      statusCheckRollup?: unknown;
      isDraft?: boolean;
    };
    const head = record.headRefName;
    if (!head) continue;
    // Skip entries missing required fields so callers don't render
    // placeholder rows (`#0`, blank title) for malformed PR records.
    if (typeof record.number !== 'number' || typeof record.title !== 'string') {
      continue;
    }
    // Mirror getAllPrSyncInfoBatch: first PR per branch wins (newest-first).
    if (byBranch.has(head)) continue;
    const reviewDecision =
      typeof record.reviewDecision === 'string' && record.reviewDecision
        ? record.reviewDecision
        : null;
    byBranch.set(head, {
      number: record.number,
      title: record.title,
      state: classifyPrState(record.state, record.mergedAt),
      baseRefName: record.baseRefName ?? null,
      mergedAt: record.mergedAt ?? null,
      reviewDecision,
      ciRollup: computeCiRollup(record.statusCheckRollup),
      isDraft: record.isDraft === true,
    });
  }

  return { byBranch, truncated: parsed.length >= BATCH_PR_LIST_LIMIT };
}

/**
 * Collapses GitHub's mixed `statusCheckRollup` (check runs + status
 * contexts) into a single coarse rollup. Failure dominates pending,
 * pending dominates success.
 */
function computeCiRollup(checks: unknown): CiStatusRollup {
  if (!Array.isArray(checks) || checks.length === 0) return 'NONE';
  let hasPending = false;
  let hasFailure = false;
  let hasSuccess = false;
  for (const c of checks) {
    if (!c || typeof c !== 'object') continue;
    const entry = c as {
      status?: string;
      conclusion?: string;
      state?: string;
    };
    const status = (entry.status ?? '').toUpperCase();
    const conclusion = (entry.conclusion ?? '').toUpperCase();
    const state = (entry.state ?? '').toUpperCase();

    // CheckRun: status='COMPLETED' means terminal; anything else is in-flight.
    if (status && status !== 'COMPLETED') {
      hasPending = true;
      continue;
    }
    const outcome = conclusion || state;
    if (
      outcome === 'SUCCESS' ||
      outcome === 'NEUTRAL' ||
      outcome === 'SKIPPED'
    ) {
      hasSuccess = true;
    } else if (
      outcome === 'PENDING' ||
      outcome === 'EXPECTED' ||
      outcome === 'QUEUED'
    ) {
      hasPending = true;
    } else if (outcome) {
      // FAILURE, TIMED_OUT, ACTION_REQUIRED, CANCELLED, ERROR, STARTUP_FAILURE
      hasFailure = true;
    }
  }
  if (hasFailure) return 'FAILURE';
  if (hasPending) return 'PENDING';
  if (hasSuccess) return 'SUCCESS';
  return 'NONE';
}

/** Merge metadata for a PR, used by `dub revert`. */
export interface PrMergeInfo {
  number: number;
  state: BranchPrLifecycleState;
  mergeCommitSha: string | null;
  headRefName: string | null;
}

/**
 * Tightened "PR not found" check used by `getPrMergeInfoByNumber`. The shared
 * `isPrNotFoundError` accepts a bare `not found` substring, which can mask
 * unrelated failures (auth, missing repo, gh upgrade prompts) and surface
 * them to the user as a misleading "PR was not found" message. This variant
 * only matches the unambiguous PR-specific phrasings + the explicit HTTP
 * `404 Not Found` form `gh` emits when the PR itself is missing.
 */
function isStrictPrNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes('could not resolve to a pull request') ||
    normalized.includes('could not resolve to a pullrequest') ||
    normalized.includes('no pull requests found') ||
    /\b404\s+not\s+found\b/i.test(message)
  );
}

/**
 * Fetches the merge metadata for a PR by number. Returns `null` when the PR
 * does not exist. `mergeCommitSha` is populated only for merged PRs; the
 * caller is responsible for translating "not merged" / "no merge commit" into
 * the right user-facing error.
 */
export async function getPrMergeInfoByNumber(
  prNumber: number,
  cwd: string,
): Promise<PrMergeInfo | null> {
  let stdout: string;
  try {
    const result = await runGh(
      [
        'pr',
        'view',
        String(prNumber),
        '--json',
        'number,state,mergedAt,mergeCommit,headRefName',
        '--jq',
        '.',
      ],
      { cwd },
    );
    stdout = result.stdout;
  } catch (error) {
    const root = unwrapRetryError(error);
    if (isStrictPrNotFoundError(root)) return null;
    const message = root instanceof Error ? root.message : String(root);
    throw new DubError(`Failed to fetch PR #${prNumber}: ${message}`, [
      `Run 'gh pr view ${prNumber}' to confirm the PR exists.`,
      "Run 'gh auth status' to verify authentication, then retry.",
    ]);
  }

  const trimmed = stdout.trim();
  if (!trimmed || trimmed === 'null') return null;

  try {
    const parsed = JSON.parse(trimmed) as {
      number?: number;
      state?: string;
      mergedAt?: string | null;
      mergeCommit?: { oid?: string | null } | null;
      headRefName?: string | null;
    };
    const number = typeof parsed.number === 'number' ? parsed.number : prNumber;
    const mergeCommitSha =
      parsed.mergeCommit && typeof parsed.mergeCommit.oid === 'string'
        ? parsed.mergeCommit.oid
        : null;
    return {
      number,
      state: classifyPrState(parsed.state, parsed.mergedAt),
      mergeCommitSha,
      headRefName: parsed.headRefName ?? null,
    };
  } catch {
    throw new DubError(`Failed to parse PR #${prNumber}.`, [
      `Run 'gh pr view ${prNumber} --json number,state,mergedAt,mergeCommit,headRefName' to inspect the response.`,
      'Retry once GitHub is healthy.',
    ]);
  }
}

/**
 * Returns coarse lifecycle state of a PR by number.
 */
export async function getPrStateByNumber(
  prNumber: number,
  cwd: string,
): Promise<BranchPrLifecycleState> {
  let stdout: string;
  try {
    const result = await runGh(
      ['pr', 'view', String(prNumber), '--json', 'state,mergedAt', '--jq', '.'],
      { cwd },
    );
    stdout = result.stdout;
  } catch (error) {
    const root = unwrapRetryError(error);
    if (isPrNotFoundError(root)) return 'NONE';
    const message = root instanceof Error ? root.message : String(root);
    throw new DubError(
      `Failed to fetch PR state for #${prNumber}: ${message}`,
      [
        `Run 'gh pr view ${prNumber}' to confirm the PR exists.`,
        "Run 'gh auth status' to verify authentication, then retry.",
      ],
    );
  }
  const trimmed = stdout.trim();
  if (!trimmed || trimmed === 'null') return 'NONE';
  try {
    const parsed = JSON.parse(trimmed) as {
      state?: string;
      mergedAt?: string | null;
    };
    if (parsed.mergedAt) return 'MERGED';
    if (parsed.state === 'OPEN') return 'OPEN';
    if (parsed.state === 'CLOSED') return 'CLOSED';
    return 'NONE';
  } catch {
    throw new DubError(`Failed to parse PR state for #${prNumber}.`, [
      `Run 'gh pr view ${prNumber} --json state,mergedAt' to inspect the response.`,
      'Retry once GitHub is healthy.',
    ]);
  }
}

/**
 * Returns GitHub's mergeability status for a PR by number.
 */
export async function getPrMergeStatusByNumber(
  prNumber: number,
  cwd: string,
): Promise<PrMergeStatus> {
  let stdout: string;
  try {
    const result = await runGh(
      [
        'pr',
        'view',
        String(prNumber),
        '--json',
        'mergeable,mergeStateStatus',
        '--jq',
        '.',
      ],
      { cwd },
    );
    stdout = result.stdout;
  } catch (error) {
    const root = unwrapRetryError(error);
    if (isPrNotFoundError(root)) {
      return {
        mergeable: null,
        mergeStateStatus: null,
      };
    }
    const message = root instanceof Error ? root.message : String(root);
    throw new DubError(
      `Failed to fetch mergeability for PR #${prNumber}: ${message}`,
      [
        `Run 'gh pr view ${prNumber}' to confirm the PR exists.`,
        "Run 'gh auth status' to verify authentication, then retry.",
      ],
    );
  }

  const trimmed = stdout.trim();
  if (!trimmed || trimmed === 'null') {
    return {
      mergeable: null,
      mergeStateStatus: null,
    };
  }

  try {
    const parsed = JSON.parse(trimmed) as {
      mergeable?: string | null;
      mergeStateStatus?: string | null;
    };
    return {
      mergeable: parsed.mergeable ?? null,
      mergeStateStatus: parsed.mergeStateStatus ?? null,
    };
  } catch {
    throw new DubError(`Failed to parse mergeability for PR #${prNumber}.`, [
      `Run 'gh pr view ${prNumber} --json mergeable,mergeStateStatus' to inspect.`,
      'Retry once GitHub is healthy.',
    ]);
  }
}

/**
 * Returns whether GitHub auto-merge is already queued for a PR.
 */
export async function isPrAutoMergeEnabled(
  prNumber: number,
  cwd: string,
): Promise<boolean> {
  let stdout: string;
  try {
    const result = await runGh(
      [
        'pr',
        'view',
        String(prNumber),
        '--json',
        'autoMergeRequest',
        '--jq',
        '.',
      ],
      { cwd },
    );
    stdout = result.stdout;
  } catch (error) {
    const root = unwrapRetryError(error);
    const message = root instanceof Error ? root.message : String(root);
    throw new DubError(
      `Failed to check auto-merge status for PR #${prNumber}: ${message}`,
      [
        `Run 'gh pr view ${prNumber} --json autoMergeRequest' to inspect the response.`,
        "Run 'gh auth status' to verify authentication, then retry.",
      ],
    );
  }

  const trimmed = stdout.trim();
  if (!trimmed || trimmed === 'null') return false;

  try {
    const parsed = JSON.parse(trimmed) as {
      autoMergeRequest?: unknown;
    };
    return parsed.autoMergeRequest != null;
  } catch {
    throw new DubError(
      `Failed to parse auto-merge status for PR #${prNumber}.`,
      [
        `Run 'gh pr view ${prNumber} --json autoMergeRequest' to inspect.`,
        'Retry once GitHub is healthy.',
      ],
    );
  }
}

/**
 * Enables GitHub auto-merge for a PR. Starts with the requested method and
 * falls back across the other GitHub-supported methods if the repository does
 * not allow that merge style.
 */
export async function enablePrAutoMerge(
  prNumber: number,
  cwd: string,
  options: { method?: MergeMethod } = {},
): Promise<EnableAutoMergeResult> {
  const methods = methodFallbackOrder(options.method ?? 'squash');
  let lastMethod = methods[0];
  let lastMessage = '';

  for (const method of methods) {
    lastMethod = method;
    try {
      await runGh(
        ['pr', 'merge', String(prNumber), '--auto', mergeMethodFlag(method)],
        { cwd, stdio: 'inherit' },
      );
      return { method };
    } catch (error) {
      const root = unwrapRetryError(error);
      lastMessage = root instanceof Error ? root.message : String(root);
      if (isMergeMethodUnavailable(lastMessage)) continue;
      throw autoMergeError(prNumber, lastMessage);
    }
  }

  throw autoMergeError(
    prNumber,
    `none of the requested merge methods are available (last tried '${lastMethod}'): ${lastMessage}`,
  );
}

function methodFallbackOrder(preferred: MergeMethod): MergeMethod[] {
  const fallback: MergeMethod[] = ['squash', 'merge', 'rebase'];
  return [preferred, ...fallback.filter((method) => method !== preferred)];
}

function mergeMethodFlag(method: MergeMethod): string {
  if (method === 'squash') return '--squash';
  if (method === 'rebase') return '--rebase';
  return '--merge';
}

function isMergeMethodUnavailable(message: string): boolean {
  const normalized = message.toLowerCase();
  const unavailable =
    normalized.includes('not allowed') ||
    normalized.includes('not enabled') ||
    normalized.includes('disabled') ||
    normalized.includes('unavailable');
  return Boolean(
    unavailable &&
      (normalized.includes('merge method') ||
        normalized.includes('squash merge') ||
        normalized.includes('rebase merge') ||
        normalized.includes('merge commit')),
  );
}

function isAutoMergeSetupUnavailable(message: string): boolean {
  const normalized = message.toLowerCase();
  if (!normalized.includes('auto-merge')) return false;
  return (
    normalized.includes('not allowed') ||
    normalized.includes('not available') ||
    normalized.includes('not enabled') ||
    normalized.includes('disabled')
  );
}

function autoMergeError(prNumber: number, message: string): DubError {
  return new DubError(
    `Failed to enable auto-merge for PR #${prNumber}: ${message}`,
    [
      'GitHub auto-merge requires repository auto-merge to be enabled and branch protection or required checks on the PR base branch.',
      `Run 'gh pr view ${prNumber} --web' to inspect merge requirements.`,
      `Run 'gh pr merge ${prNumber} --auto --squash' manually to see GitHub's raw error.`,
    ],
  );
}

function isPrNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes('could not resolve to a pull request') ||
    normalized.includes('could not resolve to a pullrequest') ||
    normalized.includes('no pull requests found') ||
    normalized.includes('not found')
  );
}

/**
 * Creates a new PR and returns its info.
 *
 * Parses the PR number from the URL printed to stdout by `gh pr create`,
 * avoiding an extra API round-trip.
 *
 * Idempotency guard: before each retry attempt, calls {@link getPr} for the
 * head branch. If a PR with the intended `title` already exists, returns it
 * instead of retrying — this prevents phantom duplicates when the first
 * attempt succeeded on GitHub but the response was lost to a transient
 * network error (e.g. 502).
 *
 * Note: this function does not route the `gh pr create` call through
 * {@link runGh} because the outer `retry` already implements retry semantics
 * with the idempotency hook between attempts. The same `ghRetryOverrides`
 * are forwarded to the outer `retry` so the test seam still applies.
 * The nested `getPr` call inside the idempotency check uses its own
 * `runGh`-driven retry — under sustained network failure this can compound
 * to up to `maxAttempts × (1 + maxAttempts)` `gh` calls before exhaustion,
 * bounded by the configured `maxAttempts` and `maxMs` of the retry helper.
 *
 * @param branch - Head branch
 * @param base - Base branch the PR merges into
 * @param title - PR title
 * @param bodyFile - Absolute path to a file containing the PR body
 */
export async function createPr(
  branch: string,
  base: string,
  title: string,
  bodyFile: string,
  cwd: string,
): Promise<PrInfo> {
  const args = [
    'pr',
    'create',
    '--head',
    branch,
    '--base',
    base,
    '--title',
    title,
    '--body-file',
    bodyFile,
  ];

  let attempt = 0;
  try {
    return await retry(
      async (): Promise<PrInfo> => {
        attempt++;
        if (attempt > 1) {
          const existing = await getPr(branch, cwd);
          if (existing && existing.title === title) {
            return existing;
          }
        }
        const { stdout } = await execa('gh', args, { cwd });
        const url = stdout.trim();
        const numberMatch = url.match(/\/pull\/(\d+)$/);
        if (!numberMatch) {
          throw new DubError(`Unexpected output from 'gh pr create': ${url}`, [
            "Inspect the printed URL; if a PR was created, rerun 'dub submit' to refresh metadata.",
            "Run 'gh --version' to verify the installed CLI version, then retry.",
          ]);
        }
        return {
          number: Number.parseInt(numberMatch[1], 10),
          url,
          title,
          body: '',
        };
      },
      {
        // DubError thrown from inside the loop is a parsing/validation
        // failure — never retry. Otherwise defer to the standard classifier.
        isPermanent: (err) =>
          err instanceof DubError || isPermanentGhError(err),
        ...ghRetryOverrides,
      },
    );
  } catch (error) {
    if (error instanceof DubError) throw error;
    const root = unwrapRetryError(error);
    const message = root instanceof Error ? root.message : String(root);
    if (message.includes('403') || message.includes('insufficient')) {
      throw new DubError('GitHub token lacks required permissions.', [
        "Run 'gh auth login' and re-select the 'repo' scope.",
        "Run 'gh auth status' to confirm the active scopes after re-login.",
      ]);
    }
    throw new DubError(`Failed to create PR for '${branch}': ${message}`, [
      `Run 'gh pr create --head ${branch}' manually to inspect the failure.`,
      'Confirm the branch has been pushed to the remote, then retry.',
    ]);
  }
}

export function buildPrCreateWebUrl(
  repoUrl: string,
  input: PrCreateWebInput,
  options: { includeBody?: boolean } = {},
): string {
  const normalizedRepoUrl = repoUrl.replace(/\/+$/, '');
  const url = new URL(
    `${normalizedRepoUrl}/compare/${encodeCompareRef(input.base)}...${encodeCompareRef(input.branch)}`,
  );
  url.searchParams.set('expand', '1');
  url.searchParams.set('title', input.title);
  if (options.includeBody ?? true) {
    url.searchParams.set('body', input.body);
  }
  return url.toString();
}

export async function openPrCreateWebFlow(
  input: PrCreateWebInput,
  cwd: string,
): Promise<PrCreateWebResult> {
  const repoUrl = await getRepositoryWebUrl(cwd);
  const bodyIncluded = input.body.length <= WEB_PR_BODY_URL_LIMIT;
  const bodyFilePath = bodyIncluded
    ? null
    : writeTempMarkdownFile('pr-body', input.body);
  const url = buildPrCreateWebUrl(repoUrl, input, {
    includeBody: bodyIncluded,
  });
  await openUrl(url);
  return { url, bodyIncluded, bodyFilePath };
}

/**
 * Updates a PR's body using a file.
 * @param prNumber - The PR number to update
 * @param bodyFile - Absolute path to a file containing the new body
 */
export async function updatePrBody(
  prNumber: number,
  bodyFile: string,
  cwd: string,
): Promise<void> {
  try {
    await runGh(['pr', 'edit', String(prNumber), '--body-file', bodyFile], {
      cwd,
    });
  } catch (error) {
    const root = unwrapRetryError(error);
    const message = root instanceof Error ? root.message : String(root);
    if (message.includes('403') || message.includes('insufficient')) {
      throw new DubError('GitHub token lacks required permissions.', [
        "Run 'gh auth login' and re-select the 'repo' scope.",
        "Run 'gh auth status' to confirm the active scopes after re-login.",
      ]);
    }
    throw new DubError(`Failed to update PR #${prNumber}: ${message}`, [
      `Run 'gh pr edit ${prNumber}' manually to inspect the failure.`,
      "Run 'gh auth status' to verify authentication, then retry.",
    ]);
  }
}

/**
 * Retargets an existing PR to a new base branch.
 */
export async function retargetPrBase(
  target: number | string,
  baseBranch: string,
  cwd: string,
): Promise<void> {
  try {
    await runGh(['pr', 'edit', String(target), '--base', baseBranch], { cwd });
  } catch (error) {
    const root = unwrapRetryError(error);
    const message = root instanceof Error ? root.message : String(root);
    throw new DubError(
      `Failed to retarget PR '${target}' to '${baseBranch}': ${message}`,
      [
        `Run 'gh pr edit ${target} --base ${baseBranch}' manually to inspect the failure.`,
        `Confirm '${baseBranch}' exists on the remote, then retry.`,
      ],
    );
  }
}

/**
 * Closes a PR by number without deleting the branch.
 *
 * Used by `dub split --close-old-pr` and by the empty-source fallback when
 * the source branch ends up with no unique commits left after the split.
 */
export async function closePr(
  prNumber: number,
  cwd: string,
  options: { comment?: string } = {},
): Promise<void> {
  const args = ['pr', 'close', String(prNumber)];
  if (options.comment && options.comment.trim().length > 0) {
    args.push('--comment', options.comment.trim());
  }
  try {
    await runGh(args, { cwd });
  } catch (error) {
    const root = unwrapRetryError(error);
    const message = root instanceof Error ? root.message : String(root);
    throw new DubError(`Failed to close PR #${prNumber}: ${message}`, [
      `Run 'gh pr close ${prNumber}' manually to inspect the failure.`,
      "Run 'gh auth status' to verify authentication, then retry.",
    ]);
  }
}

/**
 * Merges a PR by number using the requested strategy.
 */
export async function mergePr(
  prNumber: number,
  cwd: string,
  options: {
    method?: MergeMethod;
    deleteBranch?: boolean;
  } = {},
): Promise<void> {
  const method = options.method ?? 'merge';
  const methodFlag =
    method === 'squash'
      ? '--squash'
      : method === 'rebase'
        ? '--rebase'
        : '--merge';
  const args = ['pr', 'merge', String(prNumber), methodFlag];
  if (options.deleteBranch ?? true) {
    args.push('--delete-branch');
  }
  try {
    await runGh(args, { cwd, stdio: 'inherit' });
  } catch (error) {
    const root = unwrapRetryError(error);
    const message = root instanceof Error ? root.message : String(root);
    throw new DubError(`Failed to merge PR #${prNumber}: ${message}`, [
      `Run 'gh pr view ${prNumber} --web' to inspect required checks and reviews.`,
      `Run 'dub merge-check --pr ${prNumber}' to validate DubStack merge order.`,
      'Retry once required checks pass.',
    ]);
  }
}

/**
 * Closes a PR with an explanatory comment in a single `gh pr close` call.
 *
 * Used by `dub fold` when the folded branch had an open PR: the comment
 * explains where the commits went so reviewers landing on the closed PR
 * aren't left guessing.
 */
export async function closePrWithComment(
  prNumber: number,
  comment: string,
  cwd: string,
): Promise<void> {
  try {
    await runGh(['pr', 'close', String(prNumber), '--comment', comment], {
      cwd,
    });
  } catch (error) {
    const root = unwrapRetryError(error);
    const message = root instanceof Error ? root.message : String(root);
    throw new DubError(`Failed to close PR #${prNumber}: ${message}`, [
      `Run 'gh pr close ${prNumber}' manually to close the PR.`,
      "Run 'gh auth status' to verify authentication, then retry.",
    ]);
  }
}

export async function getRepositoryWebUrl(cwd: string): Promise<string> {
  const remote = await getPreferredRemote(cwd);
  let remoteUrl: string;

  try {
    const result = await execa('git', ['remote', 'get-url', remote], { cwd });
    remoteUrl = result.stdout.trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes('not a git repository')) {
      throw new DubError('Not a git repository.', [
        "Run 'git init' in the desired project directory.",
        "Run 'cd <repo>' to switch into an existing git repository and retry.",
      ]);
    }
    throw new DubError(`Failed to read git remote '${remote}': ${message}`, [
      `Run 'git remote -v' to confirm the '${remote}' remote is configured.`,
      `Run 'git remote add ${remote} <url>' to add a remote if it is missing.`,
    ]);
  }

  return normalizeGitHubRepositoryUrl(remoteUrl);
}

export async function openRepositoryInBrowser(cwd: string): Promise<void> {
  const url = await getRepositoryWebUrl(cwd);
  await openUrl(url);
}

/**
 * Opens a PR in the browser via GitHub CLI.
 *
 * @param cwd - Working directory
 * @param target - Optional branch name, PR number, or URL
 */
export async function openPrInBrowser(
  cwd: string,
  target?: string,
): Promise<void> {
  const args = target
    ? ['pr', 'view', target, '--web']
    : ['pr', 'view', '--web'];
  try {
    await runGh(args, { cwd, stdio: 'inherit' });
  } catch (error) {
    const root = unwrapRetryError(error);
    const message = root instanceof Error ? root.message : String(root);
    if (message.toLowerCase().includes('no pull requests')) {
      throw new DubError(
        target
          ? `No PR found for '${target}'.`
          : 'No PR found for the current branch.',
        target
          ? [
              `Run 'gh pr list --head ${target}' to confirm whether a PR exists.`,
              "Run 'dub submit' to push the branch and create a PR.",
            ]
          : [
              "Run 'dub submit' to push the current branch and create a PR.",
              "Run 'dub ready' to verify the branch is ready to submit.",
            ],
      );
    }
    throw new DubError(
      target
        ? `Failed to open PR for '${target}': ${message}`
        : `Failed to open PR: ${message}`,
      [
        target
          ? `Run 'gh pr view ${target} --web' manually to inspect the failure.`
          : "Run 'gh pr view --web' manually to inspect the failure.",
        "Run 'gh auth status' to verify authentication, then retry.",
      ],
    );
  }
}

async function getPreferredRemote(cwd: string): Promise<string> {
  try {
    const result = await execa(
      'git',
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
      { cwd },
    );
    const upstream = result.stdout.trim();
    const slashIndex = upstream.indexOf('/');
    if (slashIndex > 0) {
      return upstream.slice(0, slashIndex);
    }
  } catch {}

  return 'origin';
}

function normalizeGitHubRepositoryUrl(remoteUrl: string): string {
  const trimmed = remoteUrl.trim();
  const sshMatch = trimmed.match(/^git@github\.com:(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return `https://github.com/${sshMatch[1]}`;
  }

  const sshProtocolMatch = trimmed.match(
    /^ssh:\/\/git@github\.com\/(.+?)(?:\.git)?$/,
  );
  if (sshProtocolMatch) {
    return `https://github.com/${sshProtocolMatch[1]}`;
  }

  const httpsMatch = trimmed.match(/^https:\/\/github\.com\/(.+?)(?:\.git)?$/);
  if (httpsMatch) {
    return `https://github.com/${httpsMatch[1]}`;
  }

  throw new DubError(
    `Remote URL '${trimmed}' does not point to GitHub. 'dub repo' currently supports GitHub remotes only.`,
    [
      "Run 'git remote -v' to inspect configured remotes.",
      "Run 'git remote set-url origin <github-url>' to point the remote at GitHub.",
    ],
  );
}

function encodeCompareRef(ref: string): string {
  return ref.split('/').map(encodeURIComponent).join('/');
}
