import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DubError } from './errors';
import { getRepoRoot } from './git';
import {
  RECONCILE_SOURCES,
  type ReconcileSource,
  type ReconcileSourceHistogram,
} from './sync/types';

const VALID_RECONCILE_SOURCES = new Set<string>(RECONCILE_SOURCES);

/** A branch within a stack. */
export interface Branch {
  /** Branch name, e.g. "feat/api-endpoint" */
  name: string;
  /** Set to "root" for the base branch (e.g. main). Omitted for children. */
  type?: 'root';
  /**
   * True when the branch was promoted to a root by `dub unlink` rather than
   * tracked as a real git trunk. `dub sync` must skip the trunk fast-forward
   * loop for these — they're feature branches, and FFing them from
   * `origin/<branch>` would silently overwrite local commits under `--force`.
   */
  detached_root?: boolean;
  /** Name of the parent branch. `null` only for root branches. */
  parent: string | null;
  /** SHA of parent branch tip when this branch was created/last rebased */
  parent_revision?: string | null;
  /** GitHub PR number. Populated after `dub submit`. */
  pr_number: number | null;
  /** GitHub PR URL. Populated after `dub submit`. */
  pr_link: string | null;
  /** Last known remote baseline synced/submitted for this branch. */
  last_submitted_version?: {
    head_sha: string;
    base_sha: string;
    base_branch: string;
    version_number: number | null;
    source: ReconcileSource;
  } | null;
  /** Last known effective branch/base relationship after sync maintenance. */
  last_reconciled_version?: {
    head_sha: string;
    base_sha: string;
    base_branch: string;
    source: ReconcileSource;
  } | null;
  /** ISO timestamp of the most recent successful sync for this branch. */
  last_synced_at?: string | null;
  /** Source of the branch's current sync baseline metadata. */
  sync_source?: ReconcileSource | null;
  /**
   * Marker set/cleared by `dub freeze` / `dub unfreeze` and surfaced in
   * `dub log` (🔒) and `dub doctor`.
   *
   * Note: this is currently a passive marker only. `dub restack` and
   * `dub sync` do NOT yet read this field — the enforcement wiring is
   * tracked separately as DUB-82.
   */
  frozen?: boolean;
}

/** A stack of dependent branches. */
export interface Stack {
  /** Unique identifier for this stack. */
  id: string;
  /** Ordered list of branches in the stack. */
  branches: Branch[];
}

/** Summary of the most recent `dub sync` run. */
export interface LastSyncSummary {
  /** ISO timestamp the sync completed. */
  timestamp: string;
  /** Count of each `ReconcileSource` attributed to a branch this sync. */
  reconcile_sources: ReconcileSourceHistogram;
}

/** Root state persisted to `.git/dubstack/state.json`. */
export interface DubState {
  /** All tracked stacks in this repository. */
  stacks: Stack[];
  /** Summary of the most recent `dub sync` invocation. */
  last_sync?: LastSyncSummary | null;
}

/**
 * Returns the absolute path to the dubstack state file.
 * @throws {DubError} If not inside a git repository.
 */
export async function getStatePath(cwd: string): Promise<string> {
  const root = await getRepoRoot(cwd);
  return path.join(root, '.git', 'dubstack', 'state.json');
}

/**
 * Returns the absolute path to the dubstack directory inside `.git`.
 * @throws {DubError} If not inside a git repository.
 */
export async function getDubDir(cwd: string): Promise<string> {
  const root = await getRepoRoot(cwd);
  return path.join(root, '.git', 'dubstack');
}

/**
 * Reads and parses the dubstack state file.
 * @throws {DubError} If the state file is missing or contains invalid JSON.
 */
export async function readState(cwd: string): Promise<DubState> {
  const statePath = await getStatePath(cwd);
  if (!fs.existsSync(statePath)) {
    throw new DubError('DubStack is not initialized.', [
      "Run 'dub init' in the repository to initialize DubStack state.",
    ]);
  }
  try {
    const raw = fs.readFileSync(statePath, 'utf-8');
    return normalizeState(JSON.parse(raw) as DubState);
  } catch {
    throw new DubError('State file is corrupted.', [
      "Run 'rm -rf .git/dubstack' to remove the corrupted state.",
      "Run 'dub init' to re-initialize after removing the state directory.",
    ]);
  }
}

/**
 * Writes the dubstack state to disk.
 * Creates the parent directory if it doesn't exist.
 */
export async function writeState(state: DubState, cwd: string): Promise<void> {
  const statePath = await getStatePath(cwd);
  const dir = path.dirname(statePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // Write-temp-then-rename so a process kill mid-write can never leave a
  // partially-truncated state.json. fs.renameSync is atomic on the same
  // filesystem (.git/dubstack lives next to the temp file).
  const payload = `${JSON.stringify(state, null, 2)}\n`;
  const tmpPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, payload);
  try {
    fs.renameSync(tmpPath, statePath);
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
 * Initializes the dubstack state directory and file.
 * Idempotent — returns `"already_exists"` if already initialized.
 *
 * @returns `"created"` if freshly initialized, `"already_exists"` if state file already present.
 */
export async function initState(
  cwd: string,
): Promise<'created' | 'already_exists'> {
  const statePath = await getStatePath(cwd);
  const dir = path.dirname(statePath);

  if (fs.existsSync(statePath)) {
    return 'already_exists';
  }

  fs.mkdirSync(dir, { recursive: true });
  const emptyState: DubState = { stacks: [] };
  fs.writeFileSync(statePath, `${JSON.stringify(emptyState, null, 2)}\n`);
  return 'created';
}

/**
 * Returns state, auto-initializing if not yet set up.
 * Only catches the "not initialized" error — corrupt state still throws.
 */
export async function ensureState(cwd: string): Promise<DubState> {
  try {
    return await readState(cwd);
  } catch (error) {
    if (
      error instanceof DubError &&
      error.message.includes('not initialized')
    ) {
      await initState(cwd);
      return await readState(cwd);
    }
    throw error;
  }
}

/**
 * Finds the stack containing a given branch.
 * @returns The matching stack, or `undefined` if the branch isn't tracked.
 */
export function findStackForBranch(
  state: DubState,
  name: string,
): Stack | undefined {
  return state.stacks.find((stack) =>
    stack.branches.some((b) => b.name === name),
  );
}

/**
 * Returns the parent branch name for a given branch.
 * @returns The parent branch name, or `undefined` if not found or is a root.
 */
export function getParent(
  state: DubState,
  branchName: string,
): string | undefined {
  const stack = findStackForBranch(state, branchName);
  if (!stack) return undefined;

  const branch = stack.branches.find((b) => b.name === branchName);
  return branch?.parent ?? undefined;
}

/**
 * Adds a child branch to the state, linking it to its parent.
 *
 * Decision tree:
 * 1. If `child` already exists in any stack → throws `DubError` (no duplicates)
 * 2. If `parent` is found in an existing stack → appends child to that stack
 * 3. If `parent` is not in any stack → creates a new stack with parent as root
 *
 * @param state - The state to mutate (modified in place)
 * @param child - Name of the new branch
 * @param parent - Name of the parent branch
 * @param parentRevision - Optional SHA of the parent branch tip
 * @throws {DubError} If child branch already exists in state
 */
export function addBranchToStack(
  state: DubState,
  child: string,
  parent: string,
  parentRevision?: string,
): void {
  if (findStackForBranch(state, child)) {
    throw new DubError(`Branch '${child}' is already tracked in a stack.`, [
      `Run 'dub untrack ${child}' to detach it before re-adding.`,
      `Run 'dub track ${child} --parent <branch>' to move it under a new parent.`,
    ]);
  }

  const childBranch: Branch = {
    name: child,
    parent,
    ...(parentRevision != null ? { parent_revision: parentRevision } : {}),
    pr_number: null,
    pr_link: null,
    last_submitted_version: null,
    last_reconciled_version: null,
    last_synced_at: null,
    sync_source: null,
  };
  const existingStack = findStackForBranch(state, parent);

  if (existingStack) {
    existingStack.branches.push(childBranch);
  } else {
    const rootBranch: Branch = {
      name: parent,
      type: 'root',
      parent: null,
      pr_number: null,
      pr_link: null,
      last_submitted_version: null,
      last_reconciled_version: null,
      last_synced_at: null,
      sync_source: null,
    };
    state.stacks.push({
      id: crypto.randomUUID(),
      branches: [rootBranch, childBranch],
    });
  }
}

function normalizeState(state: DubState): DubState {
  const normalized: DubState = {
    stacks: state.stacks.map((stack) => ({
      ...stack,
      branches: stack.branches.map((branch) => normalizeBranch(branch)),
    })),
  };
  if (state.last_sync) {
    normalized.last_sync = state.last_sync;
  }
  return normalized;
}

const LEGACY_RECONCILE_SOURCE_MAP: Record<string, ReconcileSource> = {
  sync: 'sync-adopt-remote-safe',
  'sync-adopt-remote': 'sync-adopt-remote-safe',
  'sync-noop': 'sync-no-change',
  'sync-restack': 'sync-rebase-onto-remote',
};

function migrateReconcileSource(
  source: string | null | undefined,
): ReconcileSource | null {
  if (!source) return null;
  const mapped = LEGACY_RECONCILE_SOURCE_MAP[source];
  if (mapped) return mapped;
  if (VALID_RECONCILE_SOURCES.has(source)) return source as ReconcileSource;
  // Unknown / corrupted value — fall back to 'imported' so downstream logic
  // (e.g. isAdoptRemoteSource) treats it as untrusted provenance.
  return 'imported';
}

function normalizeBranch(branch: Branch): Branch {
  const lastSubmitted = branch.last_submitted_version
    ? {
        ...branch.last_submitted_version,
        source:
          migrateReconcileSource(branch.last_submitted_version.source) ??
          'imported',
      }
    : null;
  const lastReconciled = branch.last_reconciled_version
    ? {
        ...branch.last_reconciled_version,
        source:
          migrateReconcileSource(branch.last_reconciled_version.source) ??
          'imported',
      }
    : null;
  return {
    ...branch,
    last_submitted_version: lastSubmitted,
    last_reconciled_version: lastReconciled,
    last_synced_at: branch.last_synced_at ?? null,
    sync_source: migrateReconcileSource(branch.sync_source),
  };
}

/**
 * Returns branches in topological (BFS) order starting from the root.
 * Siblings are emitted in deterministic ascending order by branch name so
 * downstream operations (submit, restack) walk trees predictably.
 *
 * @throws {DubError} If stack metadata contains a cycle reachable from root.
 */
export function topologicalOrder(stack: Stack): Branch[] {
  const result: Branch[] = [];
  const root = stack.branches.find((b) => b.type === 'root');
  if (!root) return result;

  const childMap = new Map<string, Branch[]>();
  for (const branch of stack.branches) {
    if (branch.parent) {
      const children = childMap.get(branch.parent) ?? [];
      children.push(branch);
      childMap.set(branch.parent, children);
    }
  }
  for (const children of childMap.values()) {
    children.sort((a, b) => a.name.localeCompare(b.name));
  }

  const queue = [root];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    if (seen.has(current.name)) {
      throw new DubError(
        `Stack metadata is invalid: cycle detected at '${current.name}'.`,
        [
          "Run 'dub doctor' to inspect the stack and surface the bad parent link.",
          "Run 'dub track <branch> --parent <branch>' to re-parent the affected branch.",
        ],
      );
    }
    seen.add(current.name);
    result.push(current);
    const children = childMap.get(current.name) ?? [];
    queue.push(...children);
  }

  return result;
}
