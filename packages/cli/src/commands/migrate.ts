import { readConfig, writeConfig } from '../lib/config';
import { DubError } from '../lib/errors';
import { readJsonState, writeJsonState } from '../lib/state';
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
  const source = config.storageBackend;

  if (target === source) {
    const state =
      target === 'sqlite'
        ? await readSQLiteState(cwd)
        : await readJsonState(cwd);
    return {
      from: source,
      to: target,
      ...countState(state),
      changed: false,
    };
  }

  const state =
    target === 'sqlite' ? await readJsonState(cwd) : await readSQLiteState(cwd);

  if (target === 'sqlite') {
    await writeSQLiteState(state, cwd);
  } else {
    await writeJsonState(state, cwd);
  }

  await writeConfig(
    {
      ...config,
      storageBackend: target,
    },
    cwd,
  );

  return {
    from: source,
    to: target,
    ...countState(state),
    changed: true,
  };
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
