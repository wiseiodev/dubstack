import type { BranchPrLifecycleState, CiStatusRollup } from './github';
import type { DesktopNotification } from './notify';
import type { ActiveOperation } from './operation-state';
import type { StackOverview } from './stack-overview';

/** Per-branch slice we diff between successive polls. */
export interface BranchSnapshot {
  branch: string;
  isRoot: boolean;
  prNumber: number | null;
  prState: BranchPrLifecycleState;
  reviewDecision: string | null;
  ciRollup: CiStatusRollup;
  isDraft: boolean;
  mergedAt: string | null;
  /** Local-tip short SHA — used to detect "branch modified outside dub". */
  localShortSha: string | null;
}

/**
 * Materialized poll snapshot. Compared against the previous snapshot to
 * produce {@link WatchEvent}s. The trunk-remote and current-branch fields
 * live alongside the per-branch map so a single diff can surface all four
 * notification categories from the spec.
 */
export interface WatchSnapshot {
  byBranch: Map<string, BranchSnapshot>;
  currentBranch: string | null;
  currentBranchSha: string | null;
  /** `origin/<root>` SHA per root branch. */
  trunkRemoteShas: Map<string, string | null>;
  takenAt: number;
}

export type WatchEvent =
  | {
      kind: 'pr-review-changed';
      branch: string;
      prNumber: number;
      from: string | null;
      to: string | null;
    }
  | {
      kind: 'pr-ci-changed';
      branch: string;
      prNumber: number;
      from: CiStatusRollup;
      to: CiStatusRollup;
    }
  | {
      kind: 'pr-merged';
      branch: string;
      prNumber: number;
    }
  | {
      kind: 'trunk-advanced';
      trunk: string;
      from: string | null;
      to: string;
    }
  | {
      kind: 'branch-modified';
      branch: string;
      from: string | null;
      to: string;
    };

function snapshotFromOverview(
  overview: StackOverview,
  currentBranch: string | null,
  trunkRemoteShas: Map<string, string | null>,
  takenAt: number,
): WatchSnapshot {
  const byBranch = new Map<string, BranchSnapshot>();
  for (const row of overview.branches) {
    byBranch.set(row.branch, {
      branch: row.branch,
      isRoot: row.isRoot,
      prNumber: row.pr?.number ?? null,
      prState: row.pr?.state ?? 'NONE',
      reviewDecision: row.pr?.reviewDecision ?? null,
      ciRollup: row.pr?.ciRollup ?? 'NONE',
      isDraft: row.pr?.isDraft ?? false,
      mergedAt: row.pr?.mergedAt ?? null,
      localShortSha: row.commit?.shortSha ?? null,
    });
  }
  const currentBranchSha =
    currentBranch != null
      ? (byBranch.get(currentBranch)?.localShortSha ?? null)
      : null;
  return {
    byBranch,
    currentBranch,
    currentBranchSha,
    trunkRemoteShas,
    takenAt,
  };
}

/**
 * Computes the user-visible events between two poll snapshots. Pure (no
 * I/O) so the orchestrator can be tested by feeding two materialized
 * snapshots. The first snapshot — when `prev` is `null` — emits nothing;
 * we treat the very first poll as the baseline rather than firing a flood
 * of "changed" notifications on startup.
 */
export function diffSnapshots(
  prev: WatchSnapshot | null,
  next: WatchSnapshot,
): WatchEvent[] {
  if (!prev) return [];
  const events: WatchEvent[] = [];

  for (const [branch, after] of next.byBranch) {
    const before = prev.byBranch.get(branch);
    if (!before) continue;

    if (after.prNumber != null) {
      if (
        before.reviewDecision !== after.reviewDecision &&
        before.prNumber === after.prNumber
      ) {
        events.push({
          kind: 'pr-review-changed',
          branch,
          prNumber: after.prNumber,
          from: before.reviewDecision,
          to: after.reviewDecision,
        });
      }
      if (
        before.ciRollup !== after.ciRollup &&
        before.prNumber === after.prNumber
      ) {
        events.push({
          kind: 'pr-ci-changed',
          branch,
          prNumber: after.prNumber,
          from: before.ciRollup,
          to: after.ciRollup,
        });
      }
      if (
        before.prState !== 'MERGED' &&
        after.prState === 'MERGED' &&
        before.prNumber === after.prNumber
      ) {
        events.push({
          kind: 'pr-merged',
          branch,
          prNumber: after.prNumber,
        });
      }
    }

    // Branch-modified fires for the current branch only — that's the
    // signal a user cares about ("you committed outside dub"). Sibling
    // branch SHAs flip on every restack and would be noise.
    if (
      branch === next.currentBranch &&
      branch === prev.currentBranch &&
      before.localShortSha != null &&
      after.localShortSha != null &&
      before.localShortSha !== after.localShortSha
    ) {
      events.push({
        kind: 'branch-modified',
        branch,
        from: before.localShortSha,
        to: after.localShortSha,
      });
    }
  }

  for (const [trunk, afterSha] of next.trunkRemoteShas) {
    const beforeSha = prev.trunkRemoteShas.get(trunk) ?? null;
    if (afterSha && beforeSha && afterSha !== beforeSha) {
      events.push({
        kind: 'trunk-advanced',
        trunk,
        from: beforeSha,
        to: afterSha,
      });
    }
  }

  return events;
}

/**
 * Renders an event as a notification (title + message) and an inline
 * suggested-action line for the TUI. Centralised so the lib owns the user-
 * facing copy and tests can assert it without scraping the orchestrator.
 */
export function renderEvent(event: WatchEvent): {
  notification: DesktopNotification;
  inline: string;
} {
  switch (event.kind) {
    case 'pr-merged':
      return {
        notification: {
          title: `PR #${event.prNumber} merged`,
          message: `${event.branch} was merged. Run 'dub post-merge' to clean up.`,
        },
        inline:
          `ℹ Your PR #${event.prNumber} (${event.branch}) was merged.\n` +
          `   Run 'dub post-merge' to clean up the stack.`,
      };
    case 'pr-review-changed':
      return {
        notification: {
          title: `PR #${event.prNumber} review`,
          message: `${event.branch}: ${event.from ?? 'NONE'} → ${event.to ?? 'NONE'}`,
        },
        inline:
          `ℹ PR #${event.prNumber} (${event.branch}) review: ` +
          `${event.from ?? 'NONE'} → ${event.to ?? 'NONE'}.`,
      };
    case 'pr-ci-changed':
      return {
        notification: {
          title: `PR #${event.prNumber} CI ${event.to}`,
          message: `${event.branch}: ${event.from} → ${event.to}`,
        },
        inline:
          `ℹ PR #${event.prNumber} (${event.branch}) CI: ` +
          `${event.from} → ${event.to}.`,
      };
    case 'trunk-advanced':
      return {
        notification: {
          title: 'Trunk advanced',
          message: `${event.trunk}: ${event.from?.slice(0, 8) ?? '?'} → ${event.to.slice(0, 8)}`,
        },
        inline:
          `ℹ origin/${event.trunk} advanced.\n` +
          `   Run 'dub restack' to rebase your stack on the new trunk tip.`,
      };
    case 'branch-modified':
      return {
        notification: {
          title: `Branch ${event.branch} modified`,
          message: `${event.from} → ${event.to}`,
        },
        inline:
          `ℹ ${event.branch} moved ${event.from} → ${event.to} (outside dub).\n` +
          `   Run 'dub log' to inspect the stack.`,
      };
  }
}

export interface WatcherDeps {
  cwd: string;
  intervalMs: number;
  /** Whether to render the inline TUI status pane. */
  ui: boolean;
  notify: (n: DesktopNotification) => Promise<boolean> | boolean;
  log: (line: string) => void;
  /** Renders the live status pane (called after every successful poll). */
  renderUi: (snapshot: WatchSnapshot, paused: PauseState | null) => void;
  fetchOverview: (
    cwd: string,
    opts?: { refresh?: boolean },
  ) => Promise<StackOverview>;
  detectActiveOperation: (cwd: string) => Promise<ActiveOperation>;
  /** Returns true when `gh auth status` succeeds. Test seam. */
  ghAuthOk: () => Promise<boolean>;
  /** Returns the `origin/<branch>` SHA for each root branch (or null on miss). */
  getOriginShas: (
    cwd: string,
    rootBranches: string[],
  ) => Promise<Map<string, string | null>>;
  getCurrentBranch: (cwd: string) => Promise<string | null>;
  /**
   * Sets up a one-shot delayed callback. Returns a cancel function. The
   * orchestrator schedules itself via this seam so tests can drive the
   * loop synchronously by advancing fake timers.
   */
  scheduleTimer: (cb: () => void, ms: number) => () => void;
  /**
   * Watches each absolute path for change events. Returns a single
   * teardown function. Implementations should be resilient to missing
   * files (the cleanup-journal only exists mid-recovery).
   */
  watchFiles: (paths: string[], onChange: (file: string) => void) => () => void;
  now: () => number;
}

export type PauseReason = 'cleanup' | 'offline' | 'rate-limited';

export interface PauseState {
  reason: PauseReason;
  since: number;
}

export interface Watcher {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Visible for tests: run one poll cycle synchronously. */
  pollOnce(opts?: { trigger?: 'timer' | 'file' | 'manual' }): Promise<{
    events: WatchEvent[];
    skipped: PauseReason | null;
  }>;
  /** Returns the current pause state (or null when actively polling). */
  pauseState(): PauseState | null;
}

const RATE_LIMIT_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 5 * 60_000;

/**
 * Builds the long-lived watcher. The factory wires the dependencies but
 * does not start the loop — call `start()` to register file watchers and
 * the first poll. Tests construct the watcher with fake timers/fs and
 * drive it via `pollOnce()` directly.
 */
export function createWatcher(deps: WatcherDeps): Watcher {
  let prev: WatchSnapshot | null = null;
  let pause: PauseState | null = null;
  let timerCancel: (() => void) | null = null;
  let filesCancel: (() => void) | null = null;
  let stopped = false;
  let backoffMs = 0;
  // Serializes pollOnce: while a poll is in flight, additional file/timer
  // triggers latch this flag instead of starting a parallel loop. We
  // re-poll once on drain if anything was suppressed so HEAD flips during
  // a long poll still get serviced. Without this, a file event landing
  // mid-poll could spawn a second `schedule()` chain that overlaps the
  // first and effectively halves the configured interval.
  let polling = false;
  let pollPendingFollowup = false;

  const watchedFiles = [
    '.git/HEAD',
    '.git/index',
    '.git/dubstack/cleanup-journal.json',
  ];

  function setPause(reason: PauseReason | null): void {
    if (reason == null) {
      if (pause) {
        deps.log(`▶ resumed (was paused: ${pause.reason})`);
      }
      pause = null;
      return;
    }
    if (pause?.reason === reason) return;
    pause = { reason, since: deps.now() };
    deps.log(`⏸ paused — ${reason}`);
  }

  async function pollOnce(
    opts: { trigger?: 'timer' | 'file' | 'manual' } = {},
  ): Promise<{ events: WatchEvent[]; skipped: PauseReason | null }> {
    if (stopped) return { events: [], skipped: pause?.reason ?? null };
    if (polling) {
      // Coalesce concurrent triggers: mark a follow-up and bail. The
      // in-flight poll will re-fire once on drain via runPoll().
      pollPendingFollowup = true;
      return { events: [], skipped: pause?.reason ?? null };
    }
    polling = true;
    try {
      return await runPoll(opts);
    } finally {
      polling = false;
      if (pollPendingFollowup && !stopped) {
        pollPendingFollowup = false;
        // Fire-and-forget: caller already got its result. The follow-up
        // is a background reconciliation triggered by suppressed events.
        void runPoll({ trigger: 'file' }).catch(() => {});
      }
    }
  }

  async function runPoll(
    opts: { trigger?: 'timer' | 'file' | 'manual' } = {},
  ): Promise<{ events: WatchEvent[]; skipped: PauseReason | null }> {
    if (stopped) return { events: [], skipped: pause?.reason ?? null };

    // 1) Honor cleanup-journal pause unconditionally — the user is
    //    mid-recovery, hammering GitHub would only add noise.
    const op = await deps.detectActiveOperation(deps.cwd);
    if (op === 'cleanup') {
      setPause('cleanup');
      return { events: [], skipped: 'cleanup' };
    }
    if (pause?.reason === 'cleanup') {
      setPause(null);
    }

    // 2) Offline check (gh auth). Skipped fetch when offline; we'll
    //    re-poll at the next interval and resume when auth recovers.
    if (!(await deps.ghAuthOk())) {
      setPause('offline');
      return { events: [], skipped: 'offline' };
    }
    if (pause?.reason === 'offline') {
      setPause(null);
    }

    // 3) Honor 429 backoff: callers that hit rate-limit set `backoffMs`
    //    and we suppress polls until the timer relaxes it.
    if (pause?.reason === 'rate-limited') {
      const wait = backoffMs - (deps.now() - pause.since);
      if (wait > 0 && opts.trigger !== 'manual') {
        return { events: [], skipped: 'rate-limited' };
      }
      setPause(null);
    }

    let overview: StackOverview;
    try {
      // `refresh: true` so the watch sees fresh data; the on-disk cache
      // exists mainly to share results with one-shot commands like `dub log`.
      overview = await deps.fetchOverview(deps.cwd, { refresh: true });
      backoffMs = 0;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/\b429\b|rate.?limit/i.test(message)) {
        backoffMs = Math.min(
          backoffMs > 0 ? backoffMs * 2 : RATE_LIMIT_BACKOFF_MS,
          MAX_BACKOFF_MS,
        );
        setPause('rate-limited');
        deps.log(`⚠ GitHub rate-limited; backing off ${backoffMs}ms`);
        return { events: [], skipped: 'rate-limited' };
      }
      deps.log(`⚠ poll error: ${message}`);
      return { events: [], skipped: null };
    }

    const currentBranch = await deps
      .getCurrentBranch(deps.cwd)
      .catch(() => null);
    const rootBranches = Array.from(
      new Set(overview.branches.filter((b) => b.isRoot).map((b) => b.branch)),
    );
    const trunkRemoteShas = await deps
      .getOriginShas(deps.cwd, rootBranches)
      .catch(() => new Map<string, string | null>());

    const next = snapshotFromOverview(
      overview,
      currentBranch,
      trunkRemoteShas,
      deps.now(),
    );

    const events = diffSnapshots(prev, next);
    prev = next;

    for (const event of events) {
      const rendered = renderEvent(event);
      deps.log(rendered.inline);
      void Promise.resolve(deps.notify(rendered.notification)).catch(() => {
        // notify is already best-effort; nothing actionable here.
      });
    }

    if (deps.ui) deps.renderUi(next, pause);

    return { events, skipped: null };
  }

  function schedule(): void {
    if (stopped) return;
    timerCancel?.();
    timerCancel = deps.scheduleTimer(() => {
      // Clear the cancel handle now that the timer has fired — otherwise
      // a `stop()` racing the next pollOnce would call a stale cancel
      // that is a no-op on the underlying timer.
      timerCancel = null;
      void pollOnce({ trigger: 'timer' }).finally(() => schedule());
    }, deps.intervalMs);
  }

  async function start(): Promise<void> {
    if (stopped) throw new Error('watcher already stopped');
    filesCancel = deps.watchFiles(watchedFiles, (file) => {
      // File events drive an immediate re-poll so HEAD flips and
      // staging events show up without waiting for the next interval.
      // We dedupe via the trigger guard above (cleanup-journal pause).
      deps.log(`· file event: ${file}`);
      void pollOnce({ trigger: 'file' });
    });
    await pollOnce({ trigger: 'manual' });
    schedule();
  }

  async function stop(): Promise<void> {
    stopped = true;
    timerCancel?.();
    timerCancel = null;
    filesCancel?.();
    filesCancel = null;
  }

  return {
    start,
    stop,
    pollOnce,
    pauseState: () => pause,
  };
}
