import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { DubError } from './errors';
import { getRepoRoot } from './git';
import type { Branch, DubState, LastSyncSummary, Stack } from './state';
import { withStateLock } from './state-lock';

const require = createRequire(import.meta.url);
const SCHEMA_VERSION = 1;

let Database: typeof BetterSqlite3 | null = null;

interface StackRow {
  id: string;
  trunk: string | null;
  position: number;
}

interface TrunkRow {
  name: string;
  is_default: number | null;
}

interface BranchRow {
  name: string;
  stack_id: string;
  parent: string | null;
  type: string | null;
  detached_root: number | null;
  pr_number: number | null;
  pr_link: string | null;
  parent_revision: string | null;
  last_synced_at: string | null;
  sync_source: string | null;
  frozen: number | null;
  position: number;
  last_submitted_version_json: string | null;
  last_reconciled_version_json: string | null;
}

interface StateMetaRow {
  value: string | null;
}

export async function getSQLiteStatePath(cwd: string): Promise<string> {
  const root = await getRepoRoot(cwd);
  const dubDir = path.join(root, '.git', 'dubstack');
  return path.join(dubDir, 'state.sqlite');
}

export async function sqliteStateExists(cwd: string): Promise<boolean> {
  return fs.existsSync(await getSQLiteStatePath(cwd));
}

export async function initSQLiteState(
  cwd: string,
  initialState: DubState = { stacks: [] },
): Promise<void> {
  const dbPath = await getSQLiteStatePath(cwd);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);
  try {
    configureDatabase(db);
    ensureSchema(db);
    writeSQLiteStateToOpenDatabase(db, initialState);
  } finally {
    db.close();
  }
}

export async function readSQLiteState(cwd: string): Promise<DubState> {
  const dbPath = await getSQLiteStatePath(cwd);
  if (!fs.existsSync(dbPath)) {
    throw new DubError('DubStack is not initialized.', [
      "Run 'dub init' in the repository to initialize DubStack state.",
      "Run 'dub migrate storage --to sqlite' if this repository still uses state.json.",
    ]);
  }

  const db = openDatabase(dbPath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    ensureReadableSchema(db);
    return readSQLiteStateFromOpenDatabase(db);
  } catch (error) {
    if (error instanceof DubError) throw error;
    throw new DubError('SQLite state database is corrupted.', [
      "Run 'dub migrate storage --to json' if state.json still has the correct state.",
      'Restore .git/dubstack/state.sqlite from backup, then retry the command.',
    ]);
  } finally {
    db.close();
  }
}

export async function writeSQLiteState(
  state: DubState,
  cwd: string,
): Promise<void> {
  await withStateLock(cwd, async () => writeSQLiteStateUnlocked(state, cwd));
}

async function writeSQLiteStateUnlocked(
  state: DubState,
  cwd: string,
): Promise<void> {
  const dbPath = await getSQLiteStatePath(cwd);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);
  try {
    configureDatabase(db);
    ensureSchema(db);
    writeSQLiteStateToOpenDatabase(db, state);
  } finally {
    db.close();
  }
}

function loadDatabase(): typeof BetterSqlite3 {
  Database ??= require('better-sqlite3') as typeof BetterSqlite3;
  return Database;
}

function openDatabase(
  dbPath: string,
  options: BetterSqlite3.Options = {},
): BetterSqlite3.Database {
  const DatabaseConstructor = loadDatabase();
  return new DatabaseConstructor(dbPath, options);
}

function configureDatabase(db: BetterSqlite3.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
}

function ensureSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS state_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS trunks (
      name TEXT PRIMARY KEY,
      is_default INTEGER
    );

    CREATE TABLE IF NOT EXISTS stacks (
      id TEXT PRIMARY KEY,
      trunk TEXT,
      position INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS branches (
      name TEXT PRIMARY KEY,
      stack_id TEXT,
      parent TEXT,
      type TEXT,
      detached_root INTEGER,
      pr_number INTEGER,
      pr_link TEXT,
      parent_revision TEXT,
      last_synced_at TEXT,
      sync_source TEXT,
      frozen INTEGER,
      position INTEGER NOT NULL DEFAULT 0,
      last_submitted_version_json TEXT,
      last_reconciled_version_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_branches_stack ON branches(stack_id);
    CREATE INDEX IF NOT EXISTS idx_branches_parent ON branches(parent);
  `);
}

function ensureReadableSchema(db: BetterSqlite3.Database): void {
  const schemaVersion = db
    .prepare<[], StateMetaRow>(
      "SELECT value FROM state_meta WHERE key = 'schema_version'",
    )
    .get();
  if (!schemaVersion?.value) {
    throw new DubError('SQLite state database is missing schema metadata.', [
      "Run 'dub migrate storage --to sqlite' to rebuild the SQLite state from state.json.",
      "Run 'dub config storage-backend json' to switch back to the JSON backend.",
    ]);
  }
  if (Number(schemaVersion.value) !== SCHEMA_VERSION) {
    throw new DubError(
      `Unsupported SQLite state schema version '${schemaVersion.value}'.`,
      [
        'Upgrade DubStack to a version that supports this SQLite state schema.',
        "Run 'dub migrate storage --to json' with the matching DubStack version before downgrading.",
      ],
    );
  }
}

function writeSQLiteStateToOpenDatabase(
  db: BetterSqlite3.Database,
  state: DubState,
): void {
  const write = db.transaction((nextState: DubState) => {
    db.exec(`
      DELETE FROM branches;
      DELETE FROM stacks;
      DELETE FROM trunks;
      DELETE FROM state_meta;
    `);

    const insertMeta = db.prepare<[string, string | null]>(
      'INSERT INTO state_meta (key, value) VALUES (?, ?)',
    );
    const insertTrunk = db.prepare<[string, number]>(
      'INSERT OR REPLACE INTO trunks (name, is_default) VALUES (?, ?)',
    );
    const insertStack = db.prepare<[string, string | null, number]>(
      'INSERT INTO stacks (id, trunk, position) VALUES (?, ?, ?)',
    );
    const insertBranch = db.prepare<{
      name: string;
      stack_id: string;
      parent: string | null;
      type: string | null;
      detached_root: number | null;
      pr_number: number | null;
      pr_link: string | null;
      parent_revision: string | null;
      last_synced_at: string | null;
      sync_source: string | null;
      frozen: number | null;
      position: number;
      last_submitted_version_json: string | null;
      last_reconciled_version_json: string | null;
    }>(`
      INSERT INTO branches (
        name,
        stack_id,
        parent,
        type,
        detached_root,
        pr_number,
        pr_link,
        parent_revision,
        last_synced_at,
        sync_source,
        frozen,
        position,
        last_submitted_version_json,
        last_reconciled_version_json
      ) VALUES (
        @name,
        @stack_id,
        @parent,
        @type,
        @detached_root,
        @pr_number,
        @pr_link,
        @parent_revision,
        @last_synced_at,
        @sync_source,
        @frozen,
        @position,
        @last_submitted_version_json,
        @last_reconciled_version_json
      )
    `);

    insertMeta.run('schema_version', String(SCHEMA_VERSION));
    // Keep full-state reads fast for today's API while maintaining indexed
    // relational tables for future targeted lookups and migrations.
    insertMeta.run('raw_state', JSON.stringify(nextState));
    insertMeta.run(
      'last_sync',
      nextState.last_sync ? JSON.stringify(nextState.last_sync) : null,
    );

    const configuredTrunks = nextState.trunks ?? [];
    const defaultTrunk = nextState.defaultTrunk ?? configuredTrunks[0] ?? null;
    configuredTrunks.forEach((trunk) => {
      insertTrunk.run(trunk, trunk === defaultTrunk ? 1 : 0);
    });

    nextState.stacks.forEach((stack, stackPosition) => {
      const root = stack.branches.find((branch) => branch.type === 'root');
      const stackTrunk = stack.trunk ?? root?.name ?? null;
      insertStack.run(stack.id, stackTrunk, stackPosition);
      if (root && !configuredTrunks.includes(root.name)) {
        insertTrunk.run(root.name, stackPosition === 0 ? 1 : 0);
      }
      stack.branches.forEach((branch, position) => {
        insertBranch.run({
          name: branch.name,
          stack_id: stack.id,
          parent: branch.parent,
          type: branch.type ?? null,
          detached_root: booleanToSqlite(branch.detached_root),
          pr_number: branch.pr_number,
          pr_link: branch.pr_link,
          parent_revision: branch.parent_revision ?? null,
          last_synced_at: branch.last_synced_at ?? null,
          sync_source: branch.sync_source ?? null,
          frozen: booleanToSqlite(branch.frozen),
          position,
          last_submitted_version_json: branch.last_submitted_version
            ? JSON.stringify(branch.last_submitted_version)
            : null,
          last_reconciled_version_json: branch.last_reconciled_version
            ? JSON.stringify(branch.last_reconciled_version)
            : null,
        });
      });
    });
  });

  write(state);
}

function readSQLiteStateFromOpenDatabase(db: BetterSqlite3.Database): DubState {
  // Prefer the raw snapshot because existing commands read the whole state at
  // once; branch rows remain a durable projection for later narrow queries.
  const rawState = db
    .prepare<[], StateMetaRow>(
      "SELECT value FROM state_meta WHERE key = 'raw_state'",
    )
    .get();
  if (rawState?.value) {
    return parseJson<DubState>(rawState.value, 'raw state snapshot');
  }

  const stackRows = db
    .prepare<[], StackRow>(
      'SELECT id, trunk, position FROM stacks ORDER BY position ASC, id ASC',
    )
    .all();
  const trunkRows = db
    .prepare<[], TrunkRow>(
      'SELECT name, is_default FROM trunks ORDER BY is_default DESC, name ASC',
    )
    .all();
  const branchRows = db
    .prepare<[], BranchRow>(
      `
        SELECT
          name,
          stack_id,
          parent,
          type,
          detached_root,
          pr_number,
          pr_link,
          parent_revision,
          last_synced_at,
          sync_source,
          frozen,
          position,
          last_submitted_version_json,
          last_reconciled_version_json
        FROM branches
        ORDER BY stack_id ASC, position ASC, name ASC
      `,
    )
    .all();

  const branchesByStack = new Map<string, Branch[]>();
  for (const row of branchRows) {
    const branches = branchesByStack.get(row.stack_id) ?? [];
    branches.push(branchFromRow(row));
    branchesByStack.set(row.stack_id, branches);
  }

  const trunks = trunkRows.map((trunk) => trunk.name);
  const defaultTrunk =
    trunkRows.find((trunk) => trunk.is_default === 1)?.name ?? trunks[0];
  const state: DubState = {
    ...(trunks.length > 0 ? { trunks } : {}),
    ...(defaultTrunk ? { defaultTrunk } : {}),
    stacks: stackRows.map((stack): Stack => {
      return {
        id: stack.id,
        ...(stack.trunk ? { trunk: stack.trunk } : {}),
        branches: branchesByStack.get(stack.id) ?? [],
      };
    }),
  };

  const lastSync = db
    .prepare<[], StateMetaRow>(
      "SELECT value FROM state_meta WHERE key = 'last_sync'",
    )
    .get();
  if (lastSync?.value) {
    state.last_sync = parseJson<LastSyncSummary>(
      lastSync.value,
      'last sync metadata',
    );
  }

  return state;
}

function branchFromRow(row: BranchRow): Branch {
  return {
    name: row.name,
    ...(row.type === 'root' ? { type: 'root' as const } : {}),
    ...(row.detached_root != null
      ? { detached_root: sqliteToBoolean(row.detached_root) }
      : {}),
    parent: row.parent,
    pr_number: row.pr_number,
    pr_link: row.pr_link,
    ...(row.parent_revision != null
      ? { parent_revision: row.parent_revision }
      : {}),
    last_submitted_version: row.last_submitted_version_json
      ? parseJson<Branch['last_submitted_version']>(
          row.last_submitted_version_json,
          `last submitted version for '${row.name}'`,
        )
      : null,
    last_reconciled_version: row.last_reconciled_version_json
      ? parseJson<Branch['last_reconciled_version']>(
          row.last_reconciled_version_json,
          `last reconciled version for '${row.name}'`,
        )
      : null,
    last_synced_at: row.last_synced_at,
    sync_source: row.sync_source as Branch['sync_source'],
    ...(row.frozen != null ? { frozen: sqliteToBoolean(row.frozen) } : {}),
  };
}

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new DubError(`SQLite state has invalid ${label}.`, [
      "Run 'dub migrate storage --to sqlite' to rebuild the SQLite state from state.json.",
      'Restore .git/dubstack/state.sqlite from backup if the JSON state is unavailable.',
    ]);
  }
}

function booleanToSqlite(value: boolean | undefined): number | null {
  if (value == null) return null;
  return value ? 1 : 0;
}

function sqliteToBoolean(value: number): boolean {
  return value === 1;
}
