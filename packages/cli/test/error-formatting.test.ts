import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { abortCommand } from '../src/commands/abort';
import { create } from '../src/commands/create';
import { init } from '../src/commands/init';
import { restack } from '../src/commands/restack';
import { DubError, formatDubError } from '../src/lib/errors';
import { createTestRepo } from './helpers';

async function captureDubError(fn: () => Promise<unknown>): Promise<DubError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof DubError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected DubError to be thrown.');
}

describe('command DubError snapshots', () => {
  let repo: Awaited<ReturnType<typeof createTestRepo>>;

  beforeEach(async () => {
    repo = await createTestRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it("locks the create('--ai' + '--no-ai') error format", async () => {
    const error = await captureDubError(() =>
      create('feat/x', repo.dir, { ai: true, noAi: true }),
    );

    expect(formatDubError(error)).toMatchInlineSnapshot(`
      "'--ai' cannot be combined with '--no-ai'.

      What you can do:
        1. Pass '--ai' alone to AI-generate the branch and commit.
        2. Pass '--no-ai' alone to skip AI generation for this run."
    `);
  });

  it('locks the abort no-op error format', async () => {
    await init(repo.dir);
    const error = await captureDubError(() => abortCommand(repo.dir));

    expect(formatDubError(error)).toMatchInlineSnapshot(`
      "No operation in progress.

      What you can do:
        1. Run 'dub log' to inspect the stack.
        2. Run 'dub restack' to start restacking the current stack if you intended to."
    `);
  });

  it('locks the restack dirty-worktree error format (init dirties .gitignore)', async () => {
    await init(repo.dir);
    const error = await captureDubError(() => restack(repo.dir));

    expect(formatDubError(error)).toMatchInlineSnapshot(`
      "Working tree has uncommitted changes.

      What you can do:
        1. Run 'git status' to see the uncommitted changes.
        2. Run 'git stash' to set the changes aside, then rerun 'dub restack'.
        3. Run 'dub modify -am "<message>"' to commit the changes onto the current branch."
    `);
  });

  it("locks the create('--ai' + '-m') error format", async () => {
    const error = await captureDubError(() =>
      create('feat/x', repo.dir, { ai: true, message: 'feat: noop' }),
    );

    expect(formatDubError(error)).toMatchInlineSnapshot(`
      "'--ai' cannot be combined with '-m'.

      What you can do:
        1. Drop '--ai' to use the message you supplied.
        2. Drop '-m' to let AI generate the commit message."
    `);
  });
});
