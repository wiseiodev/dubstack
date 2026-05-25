import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestRepo,
  gitInRepo,
  withBranchWorktree,
} from '../../test/helpers';
import { DubError } from '../lib/errors';
import { foldBranch } from '../lib/fold';
import { absorb } from './absorb';
import { create } from './create';
import { init } from './init';
import { move } from './move';
import { pop } from './pop';
import { rename } from './rename';
import { reorder } from './reorder';
import { split } from './split';
import { squash } from './squash';
import { submit } from './submit';
import { unlink } from './unlink';

let dir: string;
let cleanup: () => Promise<void>;

async function writeAndCommit(
  cwd: string,
  file: string,
  contents: string,
  message: string,
): Promise<void> {
  fs.writeFileSync(path.join(cwd, file), contents);
  await gitInRepo(cwd, ['add', file]);
  await gitInRepo(cwd, ['commit', '-m', message]);
}

async function expectWorktreeRefusal(
  branch: string,
  command: string,
  run: () => Promise<unknown>,
): Promise<void> {
  await withBranchWorktree(dir, branch, async (worktreeDir) => {
    await expect(run()).rejects.toMatchObject({
      message: `Cannot run '${command}': branch '${branch}' is checked out in another worktree.`,
      recovery: expect.arrayContaining([
        `The other worktree is '${worktreeDir}'.`,
      ]),
    });
  });
}

beforeEach(async () => {
  const repo = await createTestRepo();
  dir = repo.dir;
  cleanup = repo.cleanup;
  await init(dir);
  await gitInRepo(dir, ['add', '.']);
  await gitInRepo(dir, ['commit', '-m', 'init dubstack']);
});

afterEach(async () => {
  await cleanup();
});

describe('worktree guards for mutating commands', () => {
  it('split refuses when the source branch is checked out elsewhere', async () => {
    await create('feat/a', dir);
    await writeAndCommit(dir, 'a.txt', 'a', 'feat: add a');

    await expectWorktreeRefusal('feat/a', 'dub split', () =>
      split(dir, {
        mode: 'by-file',
        files: ['a.txt'],
        name: 'feat/split-a',
      }),
    );
  });

  it('absorb refuses when the current branch is checked out elsewhere', async () => {
    await create('feat/a', dir);
    await writeAndCommit(dir, 'a.txt', 'a', 'feat: add a');
    await writeAndCommit(dir, 'a.txt', 'aa', 'fixup! feat: add a');

    await expectWorktreeRefusal('feat/a', 'dub absorb', () => absorb(dir));
  });

  it('squash refuses when the current branch is checked out elsewhere', async () => {
    await create('feat/a', dir);
    await writeAndCommit(dir, 'a.txt', 'a', 'feat: add a');
    await writeAndCommit(dir, 'b.txt', 'b', 'feat: add b');

    await expectWorktreeRefusal('feat/a', 'dub squash', () => squash(dir));
  });

  it('fold refuses when the folded branch is checked out elsewhere', async () => {
    await create('feat/a', dir);
    await writeAndCommit(dir, 'a.txt', 'a', 'feat: add a');
    await create('feat/b', dir);
    await writeAndCommit(dir, 'b.txt', 'b', 'feat: add b');

    await expectWorktreeRefusal('feat/b', 'dub fold', () => foldBranch(dir));
  });

  it('pop refuses when the current branch is checked out elsewhere', async () => {
    await create('feat/a', dir);
    await writeAndCommit(dir, 'a.txt', 'a', 'feat: add a');

    await expectWorktreeRefusal('feat/a', 'dub pop', () => pop(dir));
  });

  it('rename refuses when the source branch is checked out elsewhere', async () => {
    await create('feat/a', dir);
    await writeAndCommit(dir, 'a.txt', 'a', 'feat: add a');

    await expectWorktreeRefusal('feat/a', 'dub rename', () =>
      rename(dir, 'feat/a', 'feat/renamed-a'),
    );
  });

  it('move refuses when a reparented branch is checked out elsewhere', async () => {
    await create('feat/a', dir);
    await writeAndCommit(dir, 'a.txt', 'a', 'feat: add a');
    await create('feat/b', dir);
    await writeAndCommit(dir, 'b.txt', 'b', 'feat: add b');

    await expectWorktreeRefusal('feat/b', 'dub move', () =>
      move(dir, 'feat/b', { after: 'main' }),
    );
  });

  it('reorder refuses when the current branch is checked out elsewhere', async () => {
    await create('feat/a', dir);
    await writeAndCommit(dir, 'a.txt', 'a', 'feat: add a');
    await writeAndCommit(dir, 'b.txt', 'b', 'feat: add b');

    await expectWorktreeRefusal('feat/a', 'dub reorder', () => reorder(dir));
  });

  it('unlink refuses when the target branch is checked out elsewhere', async () => {
    await create('feat/a', dir);
    await writeAndCommit(dir, 'a.txt', 'a', 'feat: add a');

    await expectWorktreeRefusal('feat/a', 'dub unlink', () =>
      unlink(dir, 'feat/a'),
    );
  });

  it('submit refuses when a branch in scope is checked out elsewhere', async () => {
    await create('feat/a', dir);
    await writeAndCommit(dir, 'a.txt', 'a', 'feat: add a');

    await expectWorktreeRefusal('feat/a', 'dub submit', () =>
      submit(dir, false, { noAi: true }),
    );
  });

  it('throws a DubError with the worktree path in recovery hints', async () => {
    await create('feat/a', dir);
    await writeAndCommit(dir, 'a.txt', 'a', 'feat: add a');

    await withBranchWorktree(dir, 'feat/a', async (worktreeDir) => {
      try {
        await pop(dir);
        throw new Error('expected pop to refuse');
      } catch (error) {
        expect(error).toBeInstanceOf(DubError);
        expect((error as DubError).recovery.join('\n')).toContain(worktreeDir);
      }
    });
  });
});
