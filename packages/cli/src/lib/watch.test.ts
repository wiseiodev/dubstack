import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StackOverview } from './stack-overview';
import {
  createWatcher,
  diffSnapshots,
  renderEvent,
  type WatcherDeps,
  type WatchSnapshot,
} from './watch';

function snapshot(partial: Partial<WatchSnapshot> = {}): WatchSnapshot {
  return {
    byBranch: new Map(),
    currentBranch: null,
    currentBranchSha: null,
    trunkRemoteShas: new Map(),
    takenAt: 0,
    ...partial,
  };
}

function overviewBranch(over: {
  branch: string;
  isRoot?: boolean;
  prNumber?: number | null;
  prState?: 'OPEN' | 'CLOSED' | 'MERGED' | 'NONE';
  reviewDecision?: string | null;
  ciRollup?: 'SUCCESS' | 'FAILURE' | 'PENDING' | 'NONE';
  shortSha?: string | null;
  mergedAt?: string | null;
}): StackOverview['branches'][number] {
  return {
    branch: over.branch,
    parent: over.isRoot ? null : 'main',
    isRoot: over.isRoot ?? false,
    pr:
      over.prNumber != null
        ? {
            number: over.prNumber,
            title: 'PR',
            state: over.prState ?? 'OPEN',
            baseRefName: 'main',
            mergedAt: over.mergedAt ?? null,
            reviewDecision: over.reviewDecision ?? null,
            ciRollup: over.ciRollup ?? 'NONE',
            isDraft: false,
          }
        : null,
    commit:
      over.shortSha != null
        ? {
            committedRel: '1 minute ago',
            authorEmail: 'a@b',
            shortSha: over.shortSha,
          }
        : null,
    prLink: null,
    lastSyncedAt: null,
    syncSource: null,
  };
}

function overview(
  branches: ReturnType<typeof overviewBranch>[],
): StackOverview {
  return {
    branches,
    truncated: false,
    cachedAt: new Date(0).toISOString(),
  };
}

describe('diffSnapshots', () => {
  it('emits nothing on the first poll (no prev baseline)', () => {
    const next = snapshot({
      byBranch: new Map([
        [
          'feat/a',
          {
            branch: 'feat/a',
            isRoot: false,
            prNumber: 1,
            prState: 'OPEN',
            reviewDecision: null,
            ciRollup: 'PENDING',
            isDraft: false,
            mergedAt: null,
            localShortSha: 'abc12345',
          },
        ],
      ]),
    });
    expect(diffSnapshots(null, next)).toEqual([]);
  });

  it('emits pr-review-changed on review decision flip', () => {
    const base = {
      branch: 'feat/a',
      isRoot: false,
      prNumber: 1,
      prState: 'OPEN' as const,
      reviewDecision: 'REVIEW_REQUIRED' as string | null,
      ciRollup: 'SUCCESS' as const,
      isDraft: false,
      mergedAt: null as string | null,
      localShortSha: 'abc12345',
    };
    const prev = snapshot({ byBranch: new Map([['feat/a', base]]) });
    const next = snapshot({
      byBranch: new Map([['feat/a', { ...base, reviewDecision: 'APPROVED' }]]),
    });
    const events = diffSnapshots(prev, next);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'pr-review-changed',
      branch: 'feat/a',
      prNumber: 1,
      from: 'REVIEW_REQUIRED',
      to: 'APPROVED',
    });
  });

  it('emits pr-ci-changed on CI rollup transitions', () => {
    const base = {
      branch: 'feat/a',
      isRoot: false,
      prNumber: 1,
      prState: 'OPEN' as const,
      reviewDecision: null,
      ciRollup: 'PENDING' as const,
      isDraft: false,
      mergedAt: null,
      localShortSha: 'abc12345',
    };
    const prev = snapshot({ byBranch: new Map([['feat/a', base]]) });
    const next = snapshot({
      byBranch: new Map([['feat/a', { ...base, ciRollup: 'SUCCESS' }]]),
    });
    const events = diffSnapshots(prev, next);
    expect(events[0]).toMatchObject({
      kind: 'pr-ci-changed',
      from: 'PENDING',
      to: 'SUCCESS',
    });
  });

  it('emits pr-merged when prState becomes MERGED', () => {
    const base = {
      branch: 'feat/a',
      isRoot: false,
      prNumber: 7,
      prState: 'OPEN' as const,
      reviewDecision: 'APPROVED',
      ciRollup: 'SUCCESS' as const,
      isDraft: false,
      mergedAt: null,
      localShortSha: 'abc12345',
    };
    const prev = snapshot({ byBranch: new Map([['feat/a', base]]) });
    const next = snapshot({
      byBranch: new Map([
        ['feat/a', { ...base, prState: 'MERGED', mergedAt: '2026-05-24' }],
      ]),
    });
    const events = diffSnapshots(prev, next);
    expect(events.find((e) => e.kind === 'pr-merged')).toMatchObject({
      kind: 'pr-merged',
      branch: 'feat/a',
      prNumber: 7,
    });
  });

  it('emits branch-modified only for the current branch SHA flip', () => {
    const make = (sha: string) =>
      snapshot({
        currentBranch: 'feat/a',
        byBranch: new Map([
          [
            'feat/a',
            {
              branch: 'feat/a',
              isRoot: false,
              prNumber: null,
              prState: 'NONE',
              reviewDecision: null,
              ciRollup: 'NONE',
              isDraft: false,
              mergedAt: null,
              localShortSha: sha,
            },
          ],
          [
            'feat/b',
            {
              branch: 'feat/b',
              isRoot: false,
              prNumber: null,
              prState: 'NONE',
              reviewDecision: null,
              ciRollup: 'NONE',
              isDraft: false,
              mergedAt: null,
              localShortSha: 'unchanged',
            },
          ],
        ]),
      });
    const events = diffSnapshots(make('aaaa1111'), make('bbbb2222'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'branch-modified',
      branch: 'feat/a',
    });
  });

  it('emits trunk-advanced when origin/<root> SHA changes', () => {
    const prev = snapshot({
      trunkRemoteShas: new Map([['main', 'old-sha-aaaa']]),
    });
    const next = snapshot({
      trunkRemoteShas: new Map([['main', 'new-sha-bbbb']]),
    });
    const events = diffSnapshots(prev, next);
    expect(events[0]).toMatchObject({
      kind: 'trunk-advanced',
      trunk: 'main',
      to: 'new-sha-bbbb',
    });
  });
});

describe('renderEvent', () => {
  it('includes the suggested action for pr-merged', () => {
    const { inline, notification } = renderEvent({
      kind: 'pr-merged',
      branch: 'feat/a',
      prNumber: 42,
    });
    expect(inline).toContain("'dub post-merge'");
    expect(notification.title).toContain('#42');
  });

  it('suggests dub restack on trunk-advanced', () => {
    const { inline } = renderEvent({
      kind: 'trunk-advanced',
      trunk: 'main',
      from: 'a',
      to: 'b',
    });
    expect(inline).toContain("'dub restack'");
  });
});

describe('createWatcher orchestration', () => {
  let deps: WatcherDeps;
  let logged: string[];
  let notified: string[];
  let timerCb: (() => void) | null;
  let timerMs: number | null;
  let filesCb: ((file: string) => void) | null;
  let now: number;

  beforeEach(() => {
    logged = [];
    notified = [];
    timerCb = null;
    timerMs = null;
    filesCb = null;
    now = 1_000_000;

    deps = {
      cwd: '/tmp/repo',
      intervalMs: 60_000,
      ui: false,
      notify: (n) => {
        notified.push(`${n.title}|${n.message}`);
        return true;
      },
      log: (line) => logged.push(line),
      renderUi: () => {},
      fetchOverview: vi.fn(async () =>
        overview([overviewBranch({ branch: 'main', isRoot: true })]),
      ),
      detectActiveOperation: vi.fn(async () => 'none' as const),
      ghAuthOk: vi.fn(async () => true),
      getOriginShas: vi.fn(async () => new Map([['main', 'sha-1']])),
      getCurrentBranch: vi.fn(async () => 'main'),
      scheduleTimer: (cb, ms) => {
        timerCb = cb;
        timerMs = ms;
        return () => {
          timerCb = null;
        };
      },
      watchFiles: (_paths, onChange) => {
        filesCb = onChange;
        return () => {
          filesCb = null;
        };
      },
      now: () => now,
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('schedules itself at the configured interval', async () => {
    const w = createWatcher(deps);
    await w.start();
    expect(timerMs).toBe(60_000);
    expect(timerCb).not.toBeNull();
  });

  it('subscribes to .git file events that drive an immediate re-poll', async () => {
    const w = createWatcher(deps);
    await w.start();
    expect(filesCb).not.toBeNull();
    filesCb?.('/tmp/repo/.git/HEAD');
    expect(logged.some((l) => l.includes('file event'))).toBe(true);
  });

  it('pauses polling while a cleanup journal is active', async () => {
    deps.detectActiveOperation = vi.fn(async () => 'cleanup' as const);
    const w = createWatcher(deps);
    const result = await w.pollOnce({ trigger: 'manual' });
    expect(result.skipped).toBe('cleanup');
    expect(w.pauseState()?.reason).toBe('cleanup');
    expect(deps.fetchOverview).not.toHaveBeenCalled();
  });

  it('resumes after the cleanup journal clears', async () => {
    let cleanupActive = true;
    deps.detectActiveOperation = vi.fn(async () =>
      cleanupActive ? ('cleanup' as const) : ('none' as const),
    );
    const w = createWatcher(deps);
    await w.pollOnce({ trigger: 'manual' });
    expect(w.pauseState()?.reason).toBe('cleanup');
    cleanupActive = false;
    await w.pollOnce({ trigger: 'manual' });
    expect(w.pauseState()).toBeNull();
    expect(deps.fetchOverview).toHaveBeenCalled();
  });

  it('auto-pauses when gh auth fails (offline)', async () => {
    deps.ghAuthOk = vi.fn(async () => false);
    const w = createWatcher(deps);
    const result = await w.pollOnce({ trigger: 'manual' });
    expect(result.skipped).toBe('offline');
    expect(w.pauseState()?.reason).toBe('offline');
  });

  it('backs off and pauses on HTTP 429 from the overview fetch', async () => {
    deps.fetchOverview = vi.fn(async () => {
      throw new Error('GitHub responded with HTTP 429 rate limit exceeded');
    });
    const w = createWatcher(deps);
    const result = await w.pollOnce({ trigger: 'timer' });
    expect(result.skipped).toBe('rate-limited');
    expect(w.pauseState()?.reason).toBe('rate-limited');
  });

  it('emits a pr-merged event end-to-end and forwards it to notify+log', async () => {
    let calls = 0;
    deps.fetchOverview = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        return overview([
          overviewBranch({
            branch: 'feat/a',
            prNumber: 42,
            prState: 'OPEN',
            shortSha: 'a1a1a1a1',
          }),
        ]);
      }
      return overview([
        overviewBranch({
          branch: 'feat/a',
          prNumber: 42,
          prState: 'MERGED',
          mergedAt: '2026-05-24',
          shortSha: 'a1a1a1a1',
        }),
      ]);
    });
    const w = createWatcher(deps);
    await w.pollOnce({ trigger: 'manual' });
    const second = await w.pollOnce({ trigger: 'manual' });
    expect(second.events).toHaveLength(1);
    expect(second.events[0].kind).toBe('pr-merged');
    expect(notified.some((n) => n.includes('#42'))).toBe(true);
    expect(logged.some((l) => l.includes('dub post-merge'))).toBe(true);
  });

  it('coalesces concurrent file + timer triggers into a single in-flight poll', async () => {
    let inFlight = 0;
    let peakInFlight = 0;
    const resolvers: Array<() => void> = [];
    deps.fetchOverview = vi.fn(async () => {
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise<void>((resolve) => {
        resolvers.push(resolve);
      });
      inFlight--;
      return overview([overviewBranch({ branch: 'main', isRoot: true })]);
    });
    const w = createWatcher(deps);
    const first = w.pollOnce({ trigger: 'manual' });
    // Yield so `first` reaches the awaited fetchOverview (and inFlight=1).
    await Promise.resolve();
    await Promise.resolve();
    expect(inFlight).toBe(1);
    // Second trigger arrives mid-poll; it must NOT start a parallel poll.
    const second = w.pollOnce({ trigger: 'file' });
    expect(inFlight).toBe(1);
    expect(peakInFlight).toBe(1);
    // Drain the first poll; the suppressed second trigger schedules a
    // follow-up which will also block on a fresh fetch.
    resolvers[0]?.();
    await first;
    await second;
    // Allow the follow-up to start, then drain it too.
    await Promise.resolve();
    await Promise.resolve();
    resolvers[1]?.();
    expect(peakInFlight).toBe(1);
  });

  it('stop() releases the timer and file-watcher handles', async () => {
    const w = createWatcher(deps);
    await w.start();
    await w.stop();
    expect(timerCb).toBeNull();
    expect(filesCb).toBeNull();
  });
});
