import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestRepo } from '../../test/helpers';
import { DubError } from './errors';
import {
  addBranchToStack,
  type DubState,
  findStackForBranch,
  initState,
  readState,
  writeState,
} from './state';
import {
  acquireStateLock,
  getStateLockPath,
  withStateLock,
} from './state-lock';

let dir: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  const repo = await createTestRepo();
  dir = repo.dir;
  cleanup = repo.cleanup;
});

afterEach(async () => {
  await cleanup();
});

describe('readState', () => {
  it('reads valid state', async () => {
    await initState(dir);
    const state = await readState(dir);
    expect(state).toEqual({ stacks: [] });
  });

  it('throws when state file is missing', async () => {
    await expect(readState(dir)).rejects.toThrow(DubError);
    await expect(readState(dir)).rejects.toThrow('not initialized');
  });

  it('throws with actionable message on corrupt JSON', async () => {
    const dubDir = path.join(dir, '.git', 'dubstack');
    fs.mkdirSync(dubDir, { recursive: true });
    fs.writeFileSync(path.join(dubDir, 'state.json'), 'not json{{{');

    await expect(readState(dir)).rejects.toThrow(DubError);
    await expect(readState(dir)).rejects.toThrow('corrupted');
  });

  it('normalizes legacy branches without sync metadata', async () => {
    const dubDir = path.join(dir, '.git', 'dubstack');
    fs.mkdirSync(dubDir, { recursive: true });
    fs.writeFileSync(
      path.join(dubDir, 'state.json'),
      JSON.stringify(
        {
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
              ],
            },
          ],
        },
        null,
        2,
      ),
    );

    const state = await readState(dir);
    expect(state.stacks[0].branches[0].last_submitted_version).toBeNull();
    expect(state.stacks[0].branches[0].last_synced_at).toBeNull();
    expect(state.stacks[0].branches[0].sync_source).toBeNull();
  });
});

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('writeState and readState roundtrip', () => {
  it('roundtrips correctly', async () => {
    await initState(dir);
    const state: DubState = {
      stacks: [
        {
          id: 'test-id',
          branches: [
            {
              name: 'main',
              type: 'root',
              parent: null,
              pr_number: null,
              pr_link: null,
            },
            { name: 'feat/a', parent: 'main', pr_number: null, pr_link: null },
          ],
        },
      ],
    };
    await writeState(state, dir);
    const loaded = await readState(dir);
    expect(loaded.stacks[0].branches[0]).toMatchObject(
      state.stacks[0].branches[0],
    );
    expect(loaded.stacks[0].branches[1]).toMatchObject(
      state.stacks[0].branches[1],
    );
    expect(loaded.stacks[0].branches[0].last_submitted_version).toBeNull();
    expect(loaded.stacks[0].branches[0].last_synced_at).toBeNull();
    expect(loaded.stacks[0].branches[0].sync_source).toBeNull();
  });

  it('roundtrips parent_revision correctly', async () => {
    await initState(dir);
    const state: DubState = {
      stacks: [
        {
          id: 'test-id',
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
              parent_revision: 'deadbeef',
              pr_number: null,
              pr_link: null,
            },
          ],
        },
      ],
    };
    await writeState(state, dir);
    const loaded = await readState(dir);
    expect(loaded.stacks[0].branches[1].parent_revision).toBe('deadbeef');
  });

  it('normalizes and roundtrips reconciliation metadata', async () => {
    await initState(dir);
    const state: DubState = {
      stacks: [
        {
          id: 'test-id',
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
              pr_number: null,
              pr_link: null,
              last_reconciled_version: {
                head_sha: 'feat-head',
                base_sha: 'main-head',
                base_branch: 'main',
                source: 'sync-adopt-remote-safe',
              },
            },
          ],
        },
      ],
    };
    await writeState(state, dir);
    const loaded = await readState(dir);
    expect(loaded.stacks[0].branches[1].last_reconciled_version).toEqual({
      head_sha: 'feat-head',
      base_sha: 'main-head',
      base_branch: 'main',
      source: 'sync-adopt-remote-safe',
    });
  });

  it('migrates legacy reconcile source values on read', async () => {
    await initState(dir);
    const legacyState = {
      stacks: [
        {
          id: 'legacy-id',
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
              pr_number: null,
              pr_link: null,
              sync_source: 'sync',
              last_submitted_version: {
                head_sha: 'h',
                base_sha: 'b',
                base_branch: 'main',
                version_number: null,
                source: 'sync',
              },
              last_reconciled_version: {
                head_sha: 'h',
                base_sha: 'b',
                base_branch: 'main',
                source: 'sync-noop',
              },
            },
          ],
        },
      ],
    } as unknown as DubState;
    await writeState(legacyState, dir);
    const loaded = await readState(dir);
    const featA = loaded.stacks[0].branches[1];
    expect(featA.sync_source).toBe('sync-adopt-remote-safe');
    expect(featA.last_submitted_version?.source).toBe('sync-adopt-remote-safe');
    expect(featA.last_reconciled_version?.source).toBe('sync-no-change');
  });

  it('creates parent directory if missing', async () => {
    const state: DubState = { stacks: [] };
    await writeState(state, dir);
    const loaded = await readState(dir);
    expect(loaded).toEqual(state);
  });
});

describe('state lock', () => {
  it('creates and clears the lockfile around write boundaries', async () => {
    const lockPath = await getStateLockPath(dir);

    await withStateLock(dir, () => {
      expect(fs.existsSync(lockPath)).toBe(true);
      const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as {
        pid: number;
        startedAt: string;
        command: string;
      };
      expect(lock.pid).toBe(process.pid);
      expect(lock.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(lock.command).toContain('dub');
    });

    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('waits with feedback while another live process owns the lock', async () => {
    const messages: string[] = [];
    const lockPath = await getStateLockPath(dir);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      lockPath,
      `${JSON.stringify(
        {
          pid: process.pid,
          startedAt: '2026-05-23T10:15:00.000Z',
          command: 'dub sync',
        },
        null,
        2,
      )}\n`,
    );

    const second = acquireStateLock(dir, {
      commandName: 'dub create feat/a',
      retryMs: 10,
      timeoutMs: 1_000,
      onWait: (message) => messages.push(message),
      allowReentrant: false,
    });

    await waitUntil(() => messages.length > 0);
    expect(messages).toContain(
      'Another dub command (PID ' +
        `${process.pid} running \`dub sync\` since 2026-05-23T10:15:00.000Z) is currently writing state. Waiting...`,
    );

    fs.unlinkSync(lockPath);
    const secondLock = await second;
    await secondLock.release();
  });

  it('fails fast when a non-reentrant lock is requested in the same process', async () => {
    const first = await acquireStateLock(dir, { commandName: 'dub sync' });

    await expect(
      acquireStateLock(dir, {
        commandName: 'dub create feat/a',
        allowReentrant: false,
      }),
    ).rejects.toThrow('already held by this process');

    await first.release();
  });

  it('removes a newly created lockfile when writing lock metadata fails', async () => {
    const lockPath = await getStateLockPath(dir);
    const writeError = new Error('metadata write failed');
    vi.resetModules();
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      const realWriteFileSync = actual.writeFileSync as (
        file: fs.PathOrFileDescriptor,
        data: string | NodeJS.ArrayBufferView,
        options?: fs.WriteFileOptions,
      ) => void;

      return {
        ...actual,
        writeFileSync: (
          file: fs.PathOrFileDescriptor,
          data: string | NodeJS.ArrayBufferView,
          options?: fs.WriteFileOptions,
        ) => {
          if (typeof file === 'number') throw writeError;
          return realWriteFileSync(file, data, options);
        },
      };
    });

    try {
      const { acquireStateLock: acquireStateLockWithWriteFailure } =
        await import('./state-lock');
      await expect(
        acquireStateLockWithWriteFailure(dir, { commandName: 'dub sync' }),
      ).rejects.toThrow(writeError);
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }

    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('reclaims stale locks whose owner process is gone', async () => {
    const lockPath = await getStateLockPath(dir);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      lockPath,
      `${JSON.stringify(
        {
          pid: 2_147_483_647,
          startedAt: '2026-05-23T10:15:00.000Z',
          command: 'dub sync',
        },
        null,
        2,
      )}\n`,
    );

    const lock = await acquireStateLock(dir, {
      commandName: 'dub create feat/a',
      retryMs: 10,
      timeoutMs: 100,
      onWait: () => {
        throw new Error('stale lock should not wait');
      },
    });

    expect(lock.info.command).toBe('dub create feat/a');
    await lock.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('times out with a clean DubError when a live lock never clears', async () => {
    const first = await acquireStateLock(dir, {
      commandName: 'dub sync',
      retryMs: 5,
      timeoutMs: 100,
      onWait: () => {},
    });

    await expect(
      acquireStateLock(dir, {
        commandName: 'dub create feat/a',
        retryMs: 5,
        timeoutMs: 20,
        onWait: () => {},
        allowReentrant: false,
      }),
    ).rejects.toThrow(DubError);

    await first.release();
  });

  it('allows nested state locks in one invocation and releases after the outer lock', async () => {
    const lockPath = await getStateLockPath(dir);
    const outer = await acquireStateLock(dir, { commandName: 'dub create' });
    const inner = await acquireStateLock(dir, { commandName: 'dub create' });

    await inner.release();
    expect(fs.existsSync(lockPath)).toBe(true);

    await outer.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('allows read-only state reads while a write lock is held', async () => {
    await initState(dir);
    const first = await acquireStateLock(dir, {
      commandName: 'dub sync',
      retryMs: 5,
      timeoutMs: 100,
      onWait: () => {},
    });

    await expect(readState(dir)).resolves.toEqual({ stacks: [] });

    await first.release();
  });
});

describe('initState', () => {
  it('creates state file in a fresh repo', async () => {
    const result = await initState(dir);
    expect(result).toBe('created');
    const state = await readState(dir);
    expect(state).toEqual({ stacks: [] });
  });

  it("is idempotent — returns 'already_exists' on second call", async () => {
    await initState(dir);

    // Seed some data to verify it's not overwritten
    const state: DubState = {
      stacks: [
        {
          id: 'keep-me',
          branches: [
            {
              name: 'main',
              type: 'root',
              parent: null,
              pr_number: null,
              pr_link: null,
            },
          ],
        },
      ],
    };
    await writeState(state, dir);

    const result = await initState(dir);
    expect(result).toBe('already_exists');

    const loaded = await readState(dir);
    expect(loaded.stacks[0].id).toBe('keep-me');
  });
});

describe('findStackForBranch', () => {
  it('finds the correct stack', () => {
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
            { name: 'feat/a', parent: 'main', pr_number: null, pr_link: null },
          ],
        },
      ],
    };
    const stack = findStackForBranch(state, 'feat/a');
    expect(stack?.id).toBe('stack-1');
  });

  it('returns undefined for unknown branch', () => {
    const state: DubState = { stacks: [] };
    expect(findStackForBranch(state, 'unknown')).toBeUndefined();
  });
});

describe('addBranchToStack', () => {
  it('appends child to existing stack when parent is found', () => {
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
            { name: 'feat/a', parent: 'main', pr_number: null, pr_link: null },
          ],
        },
      ],
    };

    addBranchToStack(state, 'feat/b', 'feat/a');

    expect(state.stacks).toHaveLength(1);
    expect(state.stacks[0].branches).toHaveLength(3);
    expect(state.stacks[0].branches[2]).toMatchObject({
      name: 'feat/b',
      parent: 'feat/a',
      pr_number: null,
      pr_link: null,
    });
  });

  it('creates new stack when parent is not in any stack', () => {
    const state: DubState = { stacks: [] };

    addBranchToStack(state, 'feat/a', 'main');

    expect(state.stacks).toHaveLength(1);
    expect(state.stacks[0].branches).toHaveLength(2);
    expect(state.stacks[0].branches[0]).toMatchObject({
      name: 'main',
      type: 'root',
      parent: null,
    });
    expect(state.stacks[0].branches[1]).toMatchObject({
      name: 'feat/a',
      parent: 'main',
    });
  });

  it('stores parent_revision when provided', () => {
    const state: DubState = { stacks: [] };

    addBranchToStack(state, 'feat/a', 'main', 'abc123');

    expect(state.stacks[0].branches[1]).toMatchObject({
      name: 'feat/a',
      parent: 'main',
      parent_revision: 'abc123',
    });
  });

  it('omits parent_revision when not provided (backward compat)', () => {
    const state: DubState = { stacks: [] };

    addBranchToStack(state, 'feat/a', 'main');

    const branch = state.stacks[0].branches[1];
    expect(branch.name).toBe('feat/a');
    expect(branch).not.toHaveProperty('parent_revision');
  });

  it('throws when child already exists in a stack', () => {
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
            { name: 'feat/a', parent: 'main', pr_number: null, pr_link: null },
          ],
        },
      ],
    };

    expect(() => addBranchToStack(state, 'feat/a', 'main')).toThrow(DubError);
    expect(() => addBranchToStack(state, 'feat/a', 'main')).toThrow(
      'already tracked',
    );
  });
});
