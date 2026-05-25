import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DubError } from './errors';
import { execa } from './exec';
import { getCurrentBranch, getRepoRoot, isGitRepo } from './git';
import { withStateLock } from './state-lock';
import {
  initSQLiteState,
  readSQLiteState,
  sqliteStateExists,
  writeSQLiteState,
} from './state-sqlite';
import {
  RECONCILE_SOURCES,
  type ReconcileSource,
  type ReconcileSourceHistogram,
} from './sync/types';

const VALID_RECONCILE_SOURCES = new Set<string>(RECONCILE_SOURCES);
type StorageBackend = 'json' | 'sqlite';
const STATE_REF = 'refs/dubstack/state';
const BRANCH_REF_PREFIX = 'refs/dubstack/branches/';
const REFS_MIRROR_VERSION = '1';
const REFS_MIRROR_VERSION_FILE = 'refs-mirror-version';

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
   * `dub log` (🔒) and `dub doctor`. Restack, sync, and post-merge treat
   * frozen branches as planning-time skips; unfreeze explicitly before
   * running branch-mutating maintenance.
   */
  frozen?: boolean;
}

/** A stack of dependent branches. */
export interface Stack {
  /** Unique identifier for this stack. */
  id: string;
  /** Configured trunk this stack is rooted against. */
  trunk?: string;
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
  /** Configured real trunk branches in this repository. */
  trunks?: string[];
  /** Trunk used when creating a stack from an untracked branch. */
  defaultTrunk?: string;
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
  const backend = await readConfiguredStorageBackend(cwd);
  if (backend === 'sqlite') {
    return normalizeState(await readSQLiteState(cwd));
  }
  return readJsonState(cwd);
}

export async function readJsonState(cwd: string): Promise<DubState> {
  const statePath = await getStatePath(cwd);
  if (!fs.existsSync(statePath)) {
    const restored = await readStateFromRefs(cwd);
    if (restored) return restored;
    throw new DubError('DubStack is not initialized.', [
      "Run 'dub init' in the repository to initialize DubStack state.",
    ]);
  }
  try {
    const raw = fs.readFileSync(statePath, 'utf-8');
    return normalizeState(JSON.parse(raw) as DubState);
  } catch {
    const restored = await readStateFromRefs(cwd);
    if (restored) return restored;
    throw new DubError('State file is corrupted.', [
      "Run 'rm -rf .git/dubstack' to remove the corrupted state.",
      "Run 'dub init' to re-initialize after removing the state directory.",
      "Run 'dub init --restore-from-refs' to rebuild from the git refs mirror.",
    ]);
  }
}

/**
 * Writes the dubstack state to disk.
 * Creates the parent directory if it doesn't exist.
 */
export async function writeState(state: DubState, cwd: string): Promise<void> {
  await withStateLock(cwd, async () => {
    const normalized = normalizeState(state);
    const backend = await readConfiguredStorageBackend(cwd);
    if (backend === 'sqlite') {
      await writeSQLiteState(normalized, cwd);
      await mirrorStateRefs(normalized, cwd);
      return;
    }
    await writeJsonStateUnlocked(normalized, cwd);
    await mirrorStateRefs(normalized, cwd);
  });
}

export async function writeJsonState(
  state: DubState,
  cwd: string,
): Promise<void> {
  await withStateLock(cwd, async () => {
    const normalized = normalizeState(state);
    await writeJsonStateUnlocked(normalized, cwd);
    await mirrorStateRefs(normalized, cwd);
  });
}

async function writeJsonStateUnlocked(
  state: DubState,
  cwd: string,
): Promise<void> {
  const statePath = await getStatePath(cwd);
  const dir = path.dirname(statePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // Write-temp-then-rename so a process kill mid-write can never leave a
  // partially-truncated state.json. fs.renameSync is atomic on the same
  // filesystem (.git/dubstack lives next to the temp file).
  const payload = `${JSON.stringify(normalizeState(state), null, 2)}\n`;
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
  return withStateLock(cwd, async () => {
    const backend = await readConfiguredStorageBackend(cwd);
    if (backend === 'sqlite') {
      if (await sqliteStateExists(cwd)) {
        return 'already_exists';
      }
      await initSQLiteState(cwd);
      await mirrorStateRefs({ stacks: [] }, cwd);
      return 'created';
    }

    const statePath = await getStatePath(cwd);
    const dir = path.dirname(statePath);

    if (fs.existsSync(statePath)) {
      return 'already_exists';
    }

    fs.mkdirSync(dir, { recursive: true });
    const defaultTrunk = await detectDefaultTrunk(cwd);
    const emptyState: DubState = {
      trunks: [defaultTrunk],
      defaultTrunk,
      stacks: [],
    };
    fs.writeFileSync(statePath, `${JSON.stringify(emptyState, null, 2)}\n`);
    await mirrorStateRefs(emptyState, cwd);
    return 'created';
  });
}

export async function readConfiguredStorageBackend(
  cwd: string,
): Promise<StorageBackend> {
  const configPath = path.join(await getDubDir(cwd), 'config.json');
  if (!fs.existsSync(configPath)) return 'json';
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      storageBackend?: unknown;
    };
    return parsed.storageBackend === 'sqlite' ? 'sqlite' : 'json';
  } catch {
    throw new DubError('Config file is corrupted.', [
      "Run 'rm .git/dubstack/config.json' to delete the corrupted file.",
      "Run 'dub config storage-backend json' to reset the storage backend after deleting it.",
    ]);
  }
}

export async function mirrorStateRefs(
  state: DubState,
  cwd: string,
): Promise<void> {
  try {
    const normalized = normalizeState(state);
    await mirrorStateToRefs(normalized, cwd);
    writeRefsMirrorVersionMarker(await getDubDir(cwd));
  } catch (error) {
    warnRefsMirrorFailure(error);
  }
}

/**
 * Restores `.git/dubstack/state.json` from the git refs mirror.
 * @throws {DubError} If no usable mirror exists.
 */
export async function restoreStateFromRefs(cwd: string): Promise<DubState> {
  const restored = await readStateFromRefs(cwd);
  if (!restored) {
    throw new DubError('No DubStack refs mirror found.', [
      "Run 'dub init' to initialize fresh state.",
      "Run a DubStack command in a repo with existing '.git/dubstack/state.json' to create the mirror.",
    ]);
  }
  await writeState(restored, cwd);
  return restored;
}

/**
 * Mirrors existing JSON state once for repos created before the refs mirror.
 */
export async function migrateStateRefsIfNeeded(cwd: string): Promise<boolean> {
  if (!(await isGitRepo(cwd))) return false;

  try {
    const dubDir = await getDubDir(cwd);
    const markerPath = path.join(dubDir, REFS_MIRROR_VERSION_FILE);
    if (fs.existsSync(markerPath)) return false;

    const statePath = await getStatePath(cwd);
    if (!fs.existsSync(statePath)) return false;

    let state: DubState;
    try {
      const raw = fs.readFileSync(statePath, 'utf-8');
      state = normalizeState(JSON.parse(raw) as DubState);
    } catch {
      return false;
    }
    await mirrorStateToRefs(state, cwd);
    writeRefsMirrorVersionMarker(dubDir);
    return true;
  } catch (error) {
    warnRefsMirrorFailure(error);
    return false;
  }
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
  trunk?: string,
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
    existingStack.trunk = getStackTrunk(existingStack);
    ensureConfiguredTrunk(state, existingStack.trunk);
  } else {
    const stackTrunk = trunk ?? parent;
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
      trunk: stackTrunk,
      branches: [rootBranch, childBranch],
    });
    ensureConfiguredTrunk(state, stackTrunk);
  }
}

function normalizeState(state: DubState): DubState {
  const normalizedStacks = (state.stacks ?? []).map((stack) =>
    normalizeStack(stack),
  );
  const inferredTrunks = normalizedStacks
    .map((stack) => inferConfiguredTrunk(stack))
    .filter((trunk): trunk is string => Boolean(trunk));
  const trunks = uniqueNonEmpty([...(state.trunks ?? []), ...inferredTrunks]);
  const defaultTrunk =
    state.defaultTrunk && state.defaultTrunk.trim().length > 0
      ? state.defaultTrunk
      : (trunks[0] ?? 'main');
  if (!trunks.includes(defaultTrunk)) trunks.unshift(defaultTrunk);

  const normalized: DubState = {
    trunks,
    defaultTrunk,
    stacks: normalizedStacks,
  };
  if (state.last_sync) {
    normalized.last_sync = state.last_sync;
  }
  return normalized;
}

function normalizeStack(stack: Stack): Stack {
  const branches = (stack.branches ?? []).map((branch) =>
    normalizeBranch(branch),
  );
  const root = branches.find((branch) => branch.type === 'root');
  return {
    ...stack,
    trunk:
      stack.trunk && stack.trunk.trim().length > 0
        ? stack.trunk
        : root?.detached_root
          ? undefined
          : root?.name,
    branches,
  };
}

function uniqueNonEmpty(values: string[]): string[] {
  return Array.from(
    new Set(
      values.map((value) => value.trim()).filter((value) => value.length > 0),
    ),
  );
}

async function detectDefaultTrunk(cwd: string): Promise<string> {
  try {
    return await getCurrentBranch(cwd);
  } catch {
    return 'main';
  }
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

async function mirrorStateToRefs(state: DubState, cwd: string): Promise<void> {
  const branchPayloads = new Map<string, Branch>();
  for (const stack of state.stacks) {
    for (const branch of stack.branches) {
      branchPayloads.set(branch.name, branch);
    }
  }

  await pruneStaleBranchRefs(cwd, new Set(branchPayloads.keys()));

  for (const [branchName, branch] of branchPayloads) {
    const objectId = await writeBlob(
      cwd,
      `${JSON.stringify(branch, null, 2)}\n`,
    );
    await updateRef(cwd, `${BRANCH_REF_PREFIX}${branchName}`, objectId);
  }

  const stateObjectId = await writeBlob(
    cwd,
    `${JSON.stringify(state, null, 2)}\n`,
  );
  await updateRef(cwd, STATE_REF, stateObjectId);
}

async function pruneStaleBranchRefs(
  cwd: string,
  currentBranches: Set<string>,
): Promise<void> {
  const refs = await listBranchRefs(cwd);
  for (const ref of refs) {
    const branchName = ref.slice(BRANCH_REF_PREFIX.length);
    if (!currentBranches.has(branchName)) {
      await deleteRef(cwd, ref);
    }
  }
}

async function readStateFromRefs(cwd: string): Promise<DubState | null> {
  const state = await readStateRef(cwd);
  if (state) return state;
  return await reconstructStateFromBranchRefs(cwd);
}

async function readStateRef(cwd: string): Promise<DubState | null> {
  try {
    const { stdout } = await execa('git', ['cat-file', 'blob', STATE_REF], {
      cwd,
    });
    return normalizeState(JSON.parse(stdout) as DubState);
  } catch {
    return null;
  }
}

async function reconstructStateFromBranchRefs(
  cwd: string,
): Promise<DubState | null> {
  const branches = await readBranchRefs(cwd);
  if (branches.length === 0) return null;

  const branchByName = new Map(branches.map((branch) => [branch.name, branch]));
  const roots = branches
    .filter((branch) => branch.type === 'root' || branch.parent === null)
    .sort((a, b) => a.name.localeCompare(b.name));
  if (roots.length === 0) return null;

  const stacks: Stack[] = roots.map((root) => {
    const stackBranches: Branch[] = [];
    const queue = [root.name];
    const seen = new Set<string>();

    while (queue.length > 0) {
      const name = queue.shift();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const branch = branchByName.get(name);
      if (!branch) continue;
      stackBranches.push(branch);
      const children = branches
        .filter((candidate) => candidate.parent === name)
        .sort((a, b) => a.name.localeCompare(b.name));
      queue.push(...children.map((child) => child.name));
    }

    return {
      id: crypto.randomUUID(),
      branches: stackBranches,
    };
  });

  return normalizeState({ stacks });
}

async function readBranchRefs(cwd: string): Promise<Branch[]> {
  const refs = await listBranchRefs(cwd);
  const branches: Branch[] = [];
  for (const ref of refs) {
    try {
      const { stdout: payload } = await execa(
        'git',
        ['cat-file', 'blob', ref],
        {
          cwd,
        },
      );
      branches.push(normalizeBranch(JSON.parse(payload) as Branch));
    } catch {
      // Ignore individual corrupt branch refs; state ref is the primary mirror.
    }
  }
  return branches;
}

async function listBranchRefs(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execa(
      'git',
      ['for-each-ref', '--format=%(refname)', BRANCH_REF_PREFIX],
      { cwd },
    );
    const refs = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    return refs;
  } catch {
    return [];
  }
}

async function writeBlob(cwd: string, payload: string): Promise<string> {
  const { stdout } = await execa('git', ['hash-object', '-w', '--stdin'], {
    cwd,
    input: payload,
  });
  return stdout.trim();
}

async function updateRef(
  cwd: string,
  refName: string,
  objectId: string,
): Promise<void> {
  await execa('git', ['update-ref', refName, objectId], { cwd });
}

async function deleteRef(cwd: string, refName: string): Promise<void> {
  await execa('git', ['update-ref', '-d', refName], { cwd });
}

function writeRefsMirrorVersionMarker(dubDir: string): void {
  fs.mkdirSync(dubDir, { recursive: true });
  fs.writeFileSync(
    path.join(dubDir, REFS_MIRROR_VERSION_FILE),
    `${REFS_MIRROR_VERSION}\n`,
  );
}

function warnRefsMirrorFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`⚠ Failed to mirror DubStack state to git refs: ${message}`);
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

export function getStackTrunk(stack: Stack): string {
  const root = stack.branches.find((branch) => branch.type === 'root');
  return stack.trunk ?? root?.name ?? 'main';
}

export function getConfiguredTrunks(state: DubState): string[] {
  return (
    state.trunks ??
    uniqueNonEmpty(state.stacks.map((stack) => inferConfiguredTrunk(stack)))
  );
}

export function getDefaultTrunk(state: DubState): string {
  return state.defaultTrunk ?? getConfiguredTrunks(state)[0] ?? 'main';
}

export function ensureConfiguredTrunk(state: DubState, trunk: string): void {
  const trunks = new Set(state.trunks ?? []);
  trunks.add(trunk);
  state.trunks = Array.from(trunks);
  state.defaultTrunk ??= trunk;
}

function inferConfiguredTrunk(stack: Stack): string {
  if (stack.trunk) return stack.trunk;
  const root = stack.branches.find((branch) => branch.type === 'root');
  return root?.detached_root ? '' : (root?.name ?? '');
}
