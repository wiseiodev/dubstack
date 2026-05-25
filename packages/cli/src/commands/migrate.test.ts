import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestRepo } from '../../test/helpers';
import { readConfig, writeConfig } from '../lib/config';
import {
  type DubState,
  readJsonState,
  readState,
  writeJsonState,
} from '../lib/state';
import { migrateStorage } from './migrate';

let dir: string;
let cleanup: () => Promise<void>;

const state: DubState = {
  stacks: [
    {
      id: 'stack-1',
      branches: [
        {
          name: 'main',
          type: 'root',
          parent: null,
          pr_number: null,
          pr_link: null,
        },
        {
          name: 'feat/a',
          parent: 'main',
          pr_number: 12,
          pr_link: 'https://github.com/wiseiodev/dubstack/pull/12',
          frozen: true,
        },
      ],
    },
  ],
};

beforeEach(async () => {
  const repo = await createTestRepo();
  dir = repo.dir;
  cleanup = repo.cleanup;
});

afterEach(async () => {
  await cleanup();
});

describe('migrateStorage', () => {
  it('migrates JSON state to SQLite and switches the configured backend', async () => {
    await writeJsonState(state, dir);
    const normalizedState = await readJsonState(dir);

    const result = await migrateStorage(dir, 'sqlite');
    const config = await readConfig(dir);

    expect(result).toEqual({
      from: 'json',
      to: 'sqlite',
      stackCount: 1,
      branchCount: 2,
      changed: true,
    });
    expect(config.storageBackend).toBe('sqlite');
    expect(await readState(dir)).toEqual(normalizedState);
  });

  it('migrates SQLite state back to JSON', async () => {
    await writeJsonState(state, dir);
    const normalizedState = await readJsonState(dir);
    await migrateStorage(dir, 'sqlite');

    const result = await migrateStorage(dir, 'json');
    const config = await readConfig(dir);

    expect(result).toEqual({
      from: 'sqlite',
      to: 'json',
      stackCount: 1,
      branchCount: 2,
      changed: true,
    });
    expect(config.storageBackend).toBe('json');
    expect(await readJsonState(dir)).toEqual(normalizedState);
    expect(await readState(dir)).toEqual(normalizedState);
  });

  it('recovers when config already names the target but state is still in the other backend', async () => {
    await writeJsonState(state, dir);
    const normalizedState = await readJsonState(dir);
    const config = await readConfig(dir);
    await writeConfig({ ...config, storageBackend: 'sqlite' }, dir);

    const result = await migrateStorage(dir, 'sqlite');

    expect(result).toEqual({
      from: 'json',
      to: 'sqlite',
      stackCount: 1,
      branchCount: 2,
      changed: true,
    });
    expect(await readState(dir)).toEqual(normalizedState);
  });

  it('rejects invalid targets', async () => {
    await expect(migrateStorage(dir, 'postgres')).rejects.toThrow(
      "Storage migration target must be 'json' or 'sqlite'.",
    );
  });
});
