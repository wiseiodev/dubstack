import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { unlink } from '../../src/commands/unlink';
import { resumeCleanup } from '../../src/lib/cleanup-resume';
import * as github from '../../src/lib/github';
import { createTestRepo, gitInRepo } from '../helpers';

let dir: string;
let cleanup: () => Promise<void>;
let ensureGh: ReturnType<typeof vi.spyOn>;
let checkGh: ReturnType<typeof vi.spyOn>;
let getInfo: ReturnType<typeof vi.spyOn>;
let retarget: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  const repo = await createTestRepo();
  dir = repo.dir;
  cleanup = repo.cleanup;
  ensureGh = vi.spyOn(github, 'ensureGhInstalled').mockResolvedValue(undefined);
  checkGh = vi.spyOn(github, 'checkGhAuth').mockResolvedValue(undefined);
  getInfo = vi
    .spyOn(github, 'getBranchPrSyncInfo')
    .mockResolvedValue({ state: 'OPEN', baseRefName: 'feat/auth-base' });
  retarget = vi.spyOn(github, 'retargetPrBase');
});

afterEach(async () => {
  ensureGh.mockRestore();
  checkGh.mockRestore();
  getInfo.mockRestore();
  retarget.mockRestore();
  await cleanup();
});

function seedState(state: unknown) {
  const statePath = path.join(dir, '.git', 'dubstack', 'state.json');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function readStateFile(): {
  stacks: Array<{
    id: string;
    branches: Array<{ name: string; parent: string | null; type?: 'root' }>;
  }>;
} {
  const statePath = path.join(dir, '.git', 'dubstack', 'state.json');
  return JSON.parse(fs.readFileSync(statePath, 'utf-8'));
}

const journalPath = (root: string) =>
  path.join(root, '.git', 'dubstack', 'cleanup-journal.json');

describe('dub unlink crash + dub continue resume', () => {
  it('replays the retarget when unlink crashed between writeState and gh pr edit', async () => {
    // Build a real git branch graph so isWorkingTreeClean + getCurrentBranch
    // hit the live helpers without mocking.
    await gitInRepo(dir, ['checkout', '-b', 'feat/auth-base']);
    fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n');
    await gitInRepo(dir, ['add', 'base.txt']);
    await gitInRepo(dir, ['commit', '-m', 'feat: base']);
    await gitInRepo(dir, ['checkout', '-b', 'feat/auth-login']);
    fs.writeFileSync(path.join(dir, 'login.txt'), 'login\n');
    await gitInRepo(dir, ['add', 'login.txt']);
    await gitInRepo(dir, ['commit', '-m', 'feat: login']);

    seedState({
      stacks: [
        {
          id: 'stack-1',
          branches: [
            {
              name: 'main',
              parent: null,
              type: 'root',
              pr_number: null,
              pr_link: null,
            },
            {
              name: 'feat/auth-base',
              parent: 'main',
              pr_number: null,
              pr_link: null,
            },
            {
              name: 'feat/auth-login',
              parent: 'feat/auth-base',
              pr_number: 11,
              pr_link: 'https://x/11',
            },
          ],
        },
      ],
    });

    // First call: simulate a crash by making `gh pr edit` blow up. unlink
    // must persist state + leave the journal on disk for `dub continue`.
    retarget.mockRejectedValueOnce(new Error('network glitch'));

    await expect(unlink(dir, 'feat/auth-login')).rejects.toThrow(
      /network glitch/,
    );

    // State split already applied.
    const midState = readStateFile();
    expect(midState.stacks).toHaveLength(2);
    const newStack = midState.stacks.find((s) => s.id !== 'stack-1');
    expect(newStack?.branches[0]?.name).toBe('feat/auth-login');
    expect(newStack?.branches[0]?.type).toBe('root');

    // Journal stayed on disk with the pending retarget.
    expect(fs.existsSync(journalPath(dir))).toBe(true);
    const journal = JSON.parse(fs.readFileSync(journalPath(dir), 'utf-8'));
    expect(journal.operations).toEqual([
      { type: 'retarget', branch: 'feat/auth-login', newBase: 'main' },
    ]);

    // Resume succeeds. The replay reads the live PR base via getInfo (still
    // mocked to `feat/auth-base`), so the retarget op is replayed against the
    // new base `main`.
    retarget.mockResolvedValueOnce(undefined);
    const result = await resumeCleanup(dir);

    expect(result.applied).toHaveLength(1);
    expect(retarget).toHaveBeenLastCalledWith('feat/auth-login', 'main', dir);
    // Journal cleared after a clean replay.
    expect(fs.existsSync(journalPath(dir))).toBe(false);
  });
});
