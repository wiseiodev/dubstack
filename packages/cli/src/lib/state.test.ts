import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestRepo, gitInRepo } from '../../test/helpers';
import { DubError } from './errors';
import {
  addBranchToStack,
  type DubState,
  findStackForBranch,
  initState,
  migrateStateRefsIfNeeded,
  readState,
  writeState,
} from './state';

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

    const diskState = JSON.parse(
      fs.readFileSync(
        path.join(dir, '.git', 'dubstack', 'state.json'),
        'utf-8',
      ),
    ) as DubState;
    expect(diskState.stacks[0].branches[0].last_submitted_version).toBeNull();
    expect(diskState.stacks[0].branches[0].last_reconciled_version).toBeNull();
    expect(diskState.stacks[0].branches[0].last_synced_at).toBeNull();
    expect(diskState.stacks[0].branches[0].sync_source).toBeNull();
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

  it('mirrors state to git refs after writing JSON', async () => {
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

    const stateRef = await gitInRepo(dir, [
      'cat-file',
      'blob',
      'refs/dubstack/state',
    ]);
    const branchRef = await gitInRepo(dir, [
      'cat-file',
      'blob',
      'refs/dubstack/branches/feat/a',
    ]);
    expect(JSON.parse(stateRef.stdout).stacks[0].id).toBe('test-id');
    expect(JSON.parse(branchRef.stdout).name).toBe('feat/a');
  });

  it('prunes stale branch refs before writing new branch refs', async () => {
    await writeState(
      {
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
              { name: 'feat', parent: 'main', pr_number: null, pr_link: null },
            ],
          },
        ],
      },
      dir,
    );

    await writeState(
      {
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
              },
            ],
          },
        ],
      },
      dir,
    );

    const branchRef = await gitInRepo(dir, [
      'cat-file',
      'blob',
      'refs/dubstack/branches/feat/a',
    ]);
    expect(JSON.parse(branchRef.stdout).name).toBe('feat/a');
    await expect(
      gitInRepo(dir, ['show-ref', '--verify', 'refs/dubstack/branches/feat']),
    ).rejects.toThrow();
  });

  it('falls back to refs when state JSON is missing', async () => {
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
    fs.rmSync(path.join(dir, '.git', 'dubstack'), {
      recursive: true,
      force: true,
    });

    const loaded = await readState(dir);

    expect(loaded.stacks[0].id).toBe('test-id');
    expect(loaded.stacks[0].branches.map((branch) => branch.name)).toEqual([
      'main',
      'feat/a',
    ]);
  });

  it('falls back to refs when state JSON is corrupt', async () => {
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
          ],
        },
      ],
    };
    await writeState(state, dir);
    fs.writeFileSync(
      path.join(dir, '.git', 'dubstack', 'state.json'),
      'not json{{{',
    );

    const loaded = await readState(dir);

    expect(loaded.stacks[0].id).toBe('test-id');
  });

  it('keeps ref fallback consistent when branch refs are newer than state ref', async () => {
    const oldState: DubState = {
      stacks: [
        {
          id: 'old-id',
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
    await writeState(oldState, dir);
    const newerMain = {
      name: 'main',
      type: 'root',
      parent: null,
      pr_number: 123,
      pr_link: 'https://example.test/pr/123',
    };
    const objectId = childProcess
      .execFileSync('git', ['hash-object', '-w', '--stdin'], {
        cwd: dir,
        input: `${JSON.stringify(newerMain, null, 2)}\n`,
        encoding: 'utf-8',
      })
      .trim();
    await gitInRepo(dir, [
      'update-ref',
      'refs/dubstack/branches/main',
      objectId,
    ]);
    fs.rmSync(path.join(dir, '.git', 'dubstack'), {
      recursive: true,
      force: true,
    });

    const loaded = await readState(dir);

    expect(loaded.stacks[0].id).toBe('old-id');
    expect(loaded.stacks[0].branches[0].pr_number).toBeNull();
  });

  it('does not fail JSON writes when ref mirroring fails', async () => {
    await gitInRepo(dir, ['update-ref', 'refs/dubstack/state/locked', 'HEAD']);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
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
          ],
        },
      ],
    };

    await writeState(state, dir);
    const loaded = JSON.parse(
      fs.readFileSync(
        path.join(dir, '.git', 'dubstack', 'state.json'),
        'utf-8',
      ),
    );

    expect(loaded.stacks[0].id).toBe('test-id');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to mirror DubStack state to git refs'),
    );
    warn.mockRestore();
  });
});

describe('migrateStateRefsIfNeeded', () => {
  it('returns false without warning outside a git repository', async () => {
    const tmpDir = await fs.promises.mkdtemp('/tmp/dubstack-nongit-');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(migrateStateRefsIfNeeded(tmpDir)).resolves.toBe(false);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('creates refs and a marker once for existing JSON state', async () => {
    const dubDir = path.join(dir, '.git', 'dubstack');
    fs.mkdirSync(dubDir, { recursive: true });
    fs.writeFileSync(
      path.join(dubDir, 'state.json'),
      JSON.stringify(
        {
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
              ],
            },
          ],
        },
        null,
        2,
      ),
    );

    await expect(migrateStateRefsIfNeeded(dir)).resolves.toBe(true);
    await expect(migrateStateRefsIfNeeded(dir)).resolves.toBe(false);

    const stateRef = await gitInRepo(dir, [
      'cat-file',
      'blob',
      'refs/dubstack/state',
    ]);
    expect(JSON.parse(stateRef.stdout).stacks[0].id).toBe('test-id');
    expect(
      fs.readFileSync(path.join(dubDir, 'refs-mirror-version'), 'utf-8'),
    ).toBe('1\n');
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
