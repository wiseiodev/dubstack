import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { formatDuration, parseDuration } from '../lib/duration';
import { DubError } from '../lib/errors';
import { execa } from '../lib/exec';
import { getCurrentBranch, getRepoRoot } from '../lib/git';
import { checkGhAuth } from '../lib/github';
import { notify } from '../lib/notify';
import { detectActiveOperation } from '../lib/operation-state';
import { getStackOverviewBatch } from '../lib/stack-overview';
import {
  createWatcher,
  type PauseState,
  type Watcher,
  type WatcherDeps,
  type WatchSnapshot,
} from '../lib/watch';

export interface WatchOptions {
  /** Poll interval as a duration string (`30s`, `2m`). Defaults to 60s. */
  interval?: string;
  /** Render the live TUI status pane. */
  ui?: boolean;
  /** Test seam: stop after N polls. Unused in CLI. */
  maxPolls?: number;
}

const DEFAULT_INTERVAL_MS = 60_000;
const MIN_INTERVAL_MS = 5_000;

async function defaultGhAuthOk(): Promise<boolean> {
  try {
    await checkGhAuth();
    return true;
  } catch {
    return false;
  }
}

async function defaultGetOriginShas(
  cwd: string,
  rootBranches: string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  await Promise.all(
    rootBranches.map(async (root) => {
      try {
        const { stdout } = await execa(
          'git',
          ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${root}`],
          { cwd },
        );
        const sha = stdout.trim();
        out.set(root, sha || null);
      } catch {
        out.set(root, null);
      }
    }),
  );
  return out;
}

function defaultScheduleTimer(cb: () => void, ms: number): () => void {
  const handle = setTimeout(cb, ms);
  return () => clearTimeout(handle);
}

function defaultWatchFiles(
  paths: string[],
  onChange: (file: string) => void,
): () => void {
  const watchers: fs.FSWatcher[] = [];
  for (const file of paths) {
    try {
      // `persistent: false` so the watcher does not by itself keep the
      // event loop alive — the poll timer is the canonical lifeline.
      const watcher = fs.watch(file, { persistent: false }, () =>
        onChange(file),
      );
      watchers.push(watcher);
    } catch {
      // Missing files (e.g. cleanup-journal before any recovery) are
      // expected; we'll re-watch on the next start if the user manually
      // restarts the watcher.
    }
  }
  return () => {
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        // best-effort cleanup
      }
    }
  };
}

function defaultRenderUi(
  snapshot: WatchSnapshot,
  pause: PauseState | null,
): void {
  const lines: string[] = [];
  // Move cursor to home + clear screen below to redraw in place.
  process.stdout.write('\x1b[H\x1b[2J');
  lines.push(chalk.bold('dub watch'));
  if (pause) {
    lines.push(chalk.yellow(`  paused: ${pause.reason}`));
  } else {
    lines.push(
      chalk.dim(`  last poll: ${new Date(snapshot.takenAt).toISOString()}`),
    );
  }
  lines.push(
    chalk.dim(
      `  current: ${snapshot.currentBranch ?? '(detached)'} ` +
        `@ ${snapshot.currentBranchSha ?? '?'}`,
    ),
  );
  for (const [branch, b] of snapshot.byBranch) {
    const marker = branch === snapshot.currentBranch ? '*' : ' ';
    const pr = b.prNumber != null ? `#${b.prNumber}` : '----';
    const ci = b.ciRollup;
    const rd = b.reviewDecision ?? '-';
    lines.push(
      `  ${marker} ${branch.padEnd(40)}  ${pr}  ci=${ci}  review=${rd}`,
    );
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

function resolveInterval(input: string | undefined): number {
  if (!input) return DEFAULT_INTERVAL_MS;
  const parsed = parseDuration(input);
  if (parsed == null) {
    throw new DubError(`Invalid --interval value '${input}'.`, [
      'Use a duration like 30s, 2m, or 250ms.',
    ]);
  }
  if (parsed < MIN_INTERVAL_MS) {
    throw new DubError(
      `Interval ${formatDuration(parsed)} is below the ${formatDuration(MIN_INTERVAL_MS)} minimum.`,
      [
        `Pick a longer interval (e.g. --interval ${formatDuration(MIN_INTERVAL_MS)}) to avoid hammering GitHub.`,
      ],
    );
  }
  return parsed;
}

/**
 * Builds a watcher using production dependencies. Exposed (rather than
 * inlined into `watch()`) so integration tests can pass overrides for the
 * fs / gh / timer seams.
 */
export function buildWatcher(
  cwd: string,
  options: WatchOptions = {},
  overrides: Partial<WatcherDeps> = {},
): Watcher {
  const intervalMs = resolveInterval(options.interval);
  const ui = options.ui ?? false;

  const deps: WatcherDeps = {
    cwd,
    intervalMs,
    ui,
    notify,
    log: (line) => console.log(line),
    renderUi: defaultRenderUi,
    fetchOverview: getStackOverviewBatch,
    detectActiveOperation,
    ghAuthOk: defaultGhAuthOk,
    getOriginShas: defaultGetOriginShas,
    getCurrentBranch: async (dir) => {
      try {
        return await getCurrentBranch(dir);
      } catch {
        return null;
      }
    },
    scheduleTimer: defaultScheduleTimer,
    watchFiles: (paths, onChange) =>
      defaultWatchFiles(
        paths.map((p) => path.join(cwd, p)),
        (file) => onChange(file),
      ),
    now: () => Date.now(),
    ...overrides,
  };
  return createWatcher(deps);
}

/**
 * Runs `dub watch` until the process receives SIGINT/SIGTERM. Resolves
 * only when the user shuts the watcher down; tests should drive the
 * underlying watcher via {@link buildWatcher} directly rather than
 * spinning on this signal-driven loop.
 */
export async function watch(
  cwd: string,
  options: WatchOptions = {},
): Promise<void> {
  // Sanity-check that we're inside a dub-managed repo before launching
  // the long-lived loop — surfacing the failure now beats a poll-time
  // DubError ten seconds in.
  await getRepoRoot(cwd);

  const watcher = buildWatcher(cwd, options);
  const intervalMs = resolveInterval(options.interval);

  console.log(
    chalk.bold(`Watching stack — polling every ${formatDuration(intervalMs)}`),
  );
  console.log(chalk.dim('Press Ctrl-C to stop.'));

  let stopping = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    console.log(chalk.dim(`\n${signal} received — stopping watcher…`));
    await watcher.stop();
    process.exit(0);
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await watcher.start();

  // Keep the event loop alive until a signal arrives. Returning here
  // would terminate the process; instead, we hang on an unresolved
  // Promise that the signal handlers resolve via `process.exit`.
  await new Promise<void>(() => {});
}
