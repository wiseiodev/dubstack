import process from 'node:process';
import { execa } from 'execa';
import { doctor } from '../commands/doctor';
import { DubError } from './errors';
import { getCurrentBranch, getRepoRoot } from './git';
import { readHistory } from './history';
import { sanitizeRemoteUrl } from './sanitize';
import { type DubState, findStackForBranch, readState } from './state';
import type { ReconcileSourceHistogram } from './sync/types';

export { sanitizeRemoteUrl };

export type SupportBundleSourceName =
  | 'repo'
  | 'stack'
  | 'doctor'
  | 'git'
  | 'history'
  | 'tooling'
  | 'sync';

export interface SupportBundleCollectionError {
  source: SupportBundleSourceName;
  message: string;
}

export interface SupportRepoContext {
  gitRoot: string;
  currentBranch: string | null;
  remotes: string[];
}

export interface SupportStackContext {
  tracked: boolean;
  trunk: string | null;
  currentBranch: string | null;
  parentBranch: string | null;
  children: string[];
  pathToCurrent: string[];
  branchCount: number;
}

export interface SupportDoctorIssue {
  code: string;
  summary: string;
  fixes: string[];
}

export interface SupportDoctorContext {
  healthy: boolean;
  checkedBranch: string;
  issues: SupportDoctorIssue[];
}

export interface SupportGitContext {
  statusShort: string[];
  recentCommits: string[];
}

export interface SupportHistoryEntry {
  timestamp: string;
  command: string;
  status: 'success' | 'error';
  durationMs: number;
}

export interface SupportHistoryContext {
  recentEntries: SupportHistoryEntry[];
}

export interface SupportToolingContext {
  nodeVersion: string;
  platform: string;
  arch: string;
  gitVersion: string | null;
  ghVersion: string | null;
}

export interface SupportSyncContext {
  /** ISO timestamp of the most recent sync run, or null when none recorded. */
  lastSyncAt: string | null;
  /** Count of each reconcile source attributed to a branch in the last sync. */
  reconcileSources: ReconcileSourceHistogram;
}

export interface SupportBundle {
  schemaVersion: '1';
  generatedAt: string;
  cwd: string;
  collection: {
    partial: boolean;
    errors: SupportBundleCollectionError[];
  };
  sources: {
    repo: SupportRepoContext | null;
    stack: SupportStackContext | null;
    doctor: SupportDoctorContext | null;
    git: SupportGitContext | null;
    history: SupportHistoryContext | null;
    tooling: SupportToolingContext | null;
    sync: SupportSyncContext | null;
  };
}

export interface SupportBundleCollectorOverrides {
  now?: () => string;
  collectRepo?: (cwd: string) => Promise<SupportRepoContext>;
  collectStack?: (cwd: string) => Promise<SupportStackContext>;
  collectDoctor?: (cwd: string) => Promise<SupportDoctorContext>;
  collectGit?: (cwd: string) => Promise<SupportGitContext>;
  collectHistory?: (cwd: string) => Promise<SupportHistoryContext>;
  collectTooling?: (cwd: string) => Promise<SupportToolingContext>;
  collectSync?: (cwd: string) => Promise<SupportSyncContext>;
}

export interface CollectSupportBundleOptions {
  historyLimit?: number;
  collectors?: SupportBundleCollectorOverrides;
}

export async function collectSupportBundle(
  cwd: string,
  options: CollectSupportBundleOptions = {},
): Promise<SupportBundle> {
  const collectors = options.collectors ?? {};
  const errors: SupportBundleCollectionError[] = [];
  const now = collectors.now ?? (() => new Date().toISOString());

  const repo = await collectSource(
    'repo',
    errors,
    collectors.collectRepo ?? defaultCollectRepo,
    cwd,
  );
  const stack = await collectSource(
    'stack',
    errors,
    collectors.collectStack ?? defaultCollectStack,
    cwd,
  );
  const doctorContext = await collectSource(
    'doctor',
    errors,
    collectors.collectDoctor ?? defaultCollectDoctor,
    cwd,
  );
  const git = await collectSource(
    'git',
    errors,
    collectors.collectGit ?? defaultCollectGit,
    cwd,
  );
  const history = await collectSource(
    'history',
    errors,
    collectors.collectHistory ??
      ((collectorCwd: string) =>
        defaultCollectHistory(collectorCwd, options.historyLimit ?? 20)),
    cwd,
  );
  const tooling = await collectSource(
    'tooling',
    errors,
    collectors.collectTooling ?? defaultCollectTooling,
    cwd,
  );
  const syncContext = await collectSource(
    'sync',
    errors,
    collectors.collectSync ?? defaultCollectSync,
    cwd,
  );

  return {
    schemaVersion: '1',
    generatedAt: now(),
    cwd,
    collection: {
      partial: errors.length > 0,
      errors,
    },
    sources: {
      repo,
      stack,
      doctor: doctorContext,
      git,
      history,
      tooling,
      sync: syncContext,
    },
  };
}

export function formatSupportBundleSummaryMarkdown(
  bundle: SupportBundle,
): string {
  const status = bundle.collection.partial ? 'partial' : 'complete';
  const hasSourceError = (source: SupportBundleSourceName): boolean =>
    bundle.collection.errors.some((error) => error.source === source);
  const sectionLines = [
    `- repo: ${
      bundle.sources.repo && !hasSourceError('repo')
        ? 'available'
        : 'unavailable'
    }`,
    `- stack: ${describeStackStatus(bundle.sources.stack, hasSourceError('stack'))}`,
    `- doctor: ${describeDoctorStatus(
      bundle.sources.doctor,
      hasSourceError('doctor'),
    )}`,
    `- git: ${
      bundle.sources.git && !hasSourceError('git') ? 'available' : 'unavailable'
    }`,
    `- history: ${
      bundle.sources.history && !hasSourceError('history')
        ? 'available'
        : 'unavailable'
    }`,
    `- tooling: ${
      bundle.sources.tooling && !hasSourceError('tooling')
        ? 'available'
        : 'unavailable'
    }`,
    `- sync: ${describeSyncStatus(bundle.sources.sync, hasSourceError('sync'))}`,
  ];

  const syncHistogramLines = describeSyncHistogram(bundle.sources.sync);

  const historyLines =
    bundle.sources.history?.recentEntries.length === 0 ||
    !bundle.sources.history
      ? ['- none']
      : bundle.sources.history.recentEntries
          .slice(0, 6)
          .map(
            (entry) =>
              `- ${entry.timestamp} ${entry.status === 'success' ? 'OK' : 'ERR'} ${entry.command}`,
          );

  const errorLines =
    bundle.collection.errors.length === 0
      ? ['- none']
      : bundle.collection.errors.map(
          (error) => `- ${error.source}: ${error.message}`,
        );

  return [
    '# DubStack Support Report',
    '',
    `Generated at: ${bundle.generatedAt}`,
    `Collection status: ${status}`,
    '',
    '## Included Sources',
    ...sectionLines,
    '',
    '## Last Sync Reconcile Sources',
    ...syncHistogramLines,
    '',
    '## Collection Errors',
    ...errorLines,
    '',
    '## Recent Dub commands',
    ...historyLines,
  ].join('\n');
}

function describeSyncStatus(
  sync: SupportSyncContext | null,
  hasError: boolean,
): string {
  if (hasError) return 'unavailable';
  if (!sync) return 'unavailable';
  if (!sync.lastSyncAt) return 'no recorded sync';
  return `last ${sync.lastSyncAt}`;
}

function describeSyncHistogram(sync: SupportSyncContext | null): string[] {
  if (!sync) return ['- unavailable'];
  const entries = Object.entries(sync.reconcileSources).sort(
    (a, b) => (b[1] ?? 0) - (a[1] ?? 0),
  );
  if (entries.length === 0) return ['- none'];
  return entries.map(([source, count]) => `- ${source}: ${count}`);
}

async function collectSource<T>(
  source: SupportBundleSourceName,
  errors: SupportBundleCollectionError[],
  collector: (cwd: string) => Promise<T>,
  cwd: string,
): Promise<T | null> {
  try {
    return await collector(cwd);
  } catch (error) {
    errors.push({
      source,
      message: stringifyError(error),
    });
    return null;
  }
}

function describeStackStatus(
  stack: SupportStackContext | null,
  hasError: boolean,
): string {
  if (hasError) return 'unavailable';
  if (!stack) return 'unavailable';
  return stack.tracked ? 'tracked' : 'untracked';
}

function describeDoctorStatus(
  doctorContext: SupportDoctorContext | null,
  hasError: boolean,
): string {
  if (hasError) return 'unavailable';
  if (!doctorContext) return 'unavailable';
  return doctorContext.healthy ? 'healthy' : 'issues';
}

async function defaultCollectRepo(cwd: string): Promise<SupportRepoContext> {
  const gitRoot = await getRepoRoot(cwd);
  const currentBranch = await getCurrentBranch(cwd).catch(() => null);
  const remotes = await readGitRemotes(cwd);

  return {
    gitRoot,
    currentBranch,
    remotes,
  };
}

async function defaultCollectStack(cwd: string): Promise<SupportStackContext> {
  const currentBranch = await getCurrentBranch(cwd).catch(() => null);
  if (!currentBranch) {
    return createUntrackedStackContext(null);
  }

  let state: DubState;
  try {
    state = await readState(cwd);
  } catch (error: unknown) {
    if (isStateNotInitializedError(error)) {
      return createUntrackedStackContext(currentBranch);
    }
    throw error;
  }

  const stack = findStackForBranch(state, currentBranch);
  if (!stack) {
    return createUntrackedStackContext(currentBranch);
  }

  const current = stack.branches.find(
    (branch) => branch.name === currentBranch,
  );
  const root = stack.branches.find((branch) => branch.type === 'root');

  const children = stack.branches
    .filter((branch) => branch.parent === currentBranch)
    .map((branch) => branch.name)
    .sort();

  const pathToCurrent: string[] = [];
  const visited = new Set<string>();
  let cursor = current;
  let remainingSteps = stack.branches.length + 1;
  while (cursor) {
    if (visited.has(cursor.name)) {
      throw new DubError(
        `Detected a cycle in tracked stack state while resolving path for '${currentBranch}'.`,
        [
          "Run 'dub doctor' to inspect the stack for metadata damage.",
          "Run 'dub track <branch> --parent <branch>' to repair the offending parent link.",
        ],
      );
    }
    if (remainingSteps <= 0) {
      throw new DubError(
        `Exceeded path traversal limit while resolving stack path for '${currentBranch}'.`,
        ["Run 'dub doctor' to inspect the stack for metadata damage."],
      );
    }
    visited.add(cursor.name);
    remainingSteps -= 1;
    pathToCurrent.unshift(cursor.name);
    if (!cursor.parent) break;
    cursor = stack.branches.find((branch) => branch.name === cursor?.parent);
  }

  return {
    tracked: true,
    trunk: root?.name ?? null,
    currentBranch,
    parentBranch: current?.parent ?? null,
    children,
    pathToCurrent,
    branchCount: stack.branches.length,
  };
}

async function defaultCollectDoctor(
  cwd: string,
): Promise<SupportDoctorContext> {
  const result = await doctor(cwd, { all: false, fetch: false });
  return {
    healthy: result.healthy,
    checkedBranch: result.checkedBranch,
    issues: result.issues.map((issue) => ({
      code: issue.code,
      summary: issue.summary,
      fixes: issue.fixes,
    })),
  };
}

async function defaultCollectGit(cwd: string): Promise<SupportGitContext> {
  const [statusResult, commitsResult] = await Promise.allSettled([
    readGitStatusShort(cwd),
    readGitRecentCommits(cwd),
  ]);

  const statusShort =
    statusResult.status === 'fulfilled' ? statusResult.value : [];
  const recentCommits =
    commitsResult.status === 'fulfilled' ? commitsResult.value : [];

  if (
    statusResult.status === 'rejected' &&
    commitsResult.status === 'rejected'
  ) {
    throw statusResult.reason;
  }

  return {
    statusShort,
    recentCommits,
  };
}

async function defaultCollectHistory(
  cwd: string,
  historyLimit: number,
): Promise<SupportHistoryContext> {
  const entries = await readHistory(cwd, { limit: historyLimit });
  return {
    recentEntries: entries.map((entry) => ({
      timestamp: entry.timestamp,
      command: entry.command,
      status: entry.status,
      durationMs: entry.durationMs,
    })),
  };
}

async function defaultCollectSync(cwd: string): Promise<SupportSyncContext> {
  let state: DubState;
  try {
    state = await readState(cwd);
  } catch {
    // Missing/corrupt state behaves the same as "no sync recorded" from a
    // diagnostics perspective — don't propagate the error and partial-fail.
    return { lastSyncAt: null, reconcileSources: {} };
  }
  const lastSync = state.last_sync ?? null;
  return {
    lastSyncAt: lastSync?.timestamp ?? null,
    reconcileSources: lastSync?.reconcile_sources ?? {},
  };
}

async function defaultCollectTooling(
  _cwd: string,
): Promise<SupportToolingContext> {
  return {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    gitVersion: await readVersionLine('git', ['--version']),
    ghVersion: await readVersionLine('gh', ['--version']),
  };
}

async function readVersionLine(
  command: string,
  args: string[],
): Promise<string | null> {
  try {
    const { stdout } = await execa(command, args);
    const firstLine = stdout.split('\n')[0]?.trim();
    return firstLine || null;
  } catch {
    return null;
  }
}

function stringifyError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

function isStateNotInitializedError(error: unknown): boolean {
  return error instanceof DubError && error.message.includes('not initialized');
}

function createUntrackedStackContext(
  currentBranch: string | null,
): SupportStackContext {
  return {
    tracked: false,
    trunk: null,
    currentBranch,
    parentBranch: null,
    children: [],
    pathToCurrent: [],
    branchCount: 0,
  };
}

async function readGitRemotes(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execa('git', ['remote', '-v'], { cwd });
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => sanitizeRemoteLine(line))
      .slice(0, 20);
  } catch {
    return [];
  }
}

async function readGitStatusShort(cwd: string): Promise<string[]> {
  const { stdout } = await execa('git', ['status', '--short', '--branch'], {
    cwd,
  });
  return stdout
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(0, 120);
}

async function readGitRecentCommits(cwd: string): Promise<string[]> {
  const { stdout } = await execa('git', ['log', '--oneline', '-20'], {
    cwd,
  });
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 20);
}

function sanitizeRemoteLine(line: string): string {
  const parts = line.split(/\s+/);
  if (parts.length < 2) return line;

  const remote = parts[0] ?? '';
  const url = parts[1] ?? '';
  const suffix = parts.length > 2 ? ` ${parts.slice(2).join(' ')}` : '';
  return `${remote} ${sanitizeRemoteUrl(url)}${suffix}`;
}
