import { readConfig, writeConfig } from '../lib/config';
import { DubError } from '../lib/errors';
import { type DubState, readJsonState, writeJsonState } from '../lib/state';
import { withStateLock } from '../lib/state-lock';
import { readSQLiteState, writeSQLiteState } from '../lib/state-sqlite';

export type StorageMigrationTarget = 'json' | 'sqlite';

export interface StorageMigrationResult {
  from: StorageMigrationTarget;
  to: StorageMigrationTarget;
  stackCount: number;
  branchCount: number;
  changed: boolean;
}

export async function migrateStorage(
  cwd: string,
  to: string,
): Promise<StorageMigrationResult> {
  return withStateLock(cwd, async () => migrateStorageLocked(cwd, to));
}

async function migrateStorageLocked(
  cwd: string,
  to: string,
): Promise<StorageMigrationResult> {
  const target = parseStorageMigrationTarget(to);
  const config = await readConfig(cwd);
  const source = await resolveMigrationSource(cwd, config.storageBackend);
  const writeTargetState = source.from !== target;
  const writeTargetConfig = config.storageBackend !== target;

  if (writeTargetState) {
    await writeStateForBackend(target, source.state, cwd);
  }

  if (writeTargetConfig) {
    await writeConfig(
      {
        ...config,
        storageBackend: target,
      },
      cwd,
    );
  }

  return {
    from: source.from,
    to: target,
    ...countState(source.state),
    changed: writeTargetState || writeTargetConfig,
  };
}

async function resolveMigrationSource(
  cwd: string,
  configuredBackend: StorageMigrationTarget,
): Promise<{
  from: StorageMigrationTarget;
  state: DubState;
}> {
  const configured = await tryReadBackend(configuredBackend, cwd);
  if (configured.ok) {
    return { from: configuredBackend, state: configured.state };
  }

  const fallbackBackend = oppositeBackend(configuredBackend);
  const fallback = await tryReadBackend(fallbackBackend, cwd);
  if (fallback.ok) {
    return { from: fallbackBackend, state: fallback.state };
  }

  throw configured.error;
}

async function tryReadBackend(
  backend: StorageMigrationTarget,
  cwd: string,
): Promise<{ ok: true; state: DubState } | { ok: false; error: unknown }> {
  try {
    return { ok: true, state: await readStateForBackend(backend, cwd) };
  } catch (error) {
    return { ok: false, error };
  }
}

function readStateForBackend(
  backend: StorageMigrationTarget,
  cwd: string,
): Promise<DubState> {
  return backend === 'sqlite' ? readSQLiteState(cwd) : readJsonState(cwd);
}

function writeStateForBackend(
  backend: StorageMigrationTarget,
  state: DubState,
  cwd: string,
): Promise<void> {
  return backend === 'sqlite'
    ? writeSQLiteState(state, cwd)
    : writeJsonState(state, cwd);
}

function oppositeBackend(
  backend: StorageMigrationTarget,
): StorageMigrationTarget {
  return backend === 'sqlite' ? 'json' : 'sqlite';
}

function parseStorageMigrationTarget(value: string): StorageMigrationTarget {
  if (value === 'json' || value === 'sqlite') return value;
  throw new DubError("Storage migration target must be 'json' or 'sqlite'.", [
    "Run 'dub migrate storage --to sqlite' to opt in to SQLite state storage.",
    "Run 'dub migrate storage --to json' to switch back to state.json.",
  ]);
}

function countState(state: { stacks: Array<{ branches: unknown[] }> }): {
  stackCount: number;
  branchCount: number;
} {
  return {
    stackCount: state.stacks.length,
    branchCount: state.stacks.reduce(
      (total, stack) => total + stack.branches.length,
      0,
    ),
  };
}
