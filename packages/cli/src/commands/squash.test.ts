import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestRepo, gitInRepo } from '../../test/helpers';
import { writeConfig } from '../lib/config';
import { DubError } from '../lib/errors';
import { getBranchTip } from '../lib/git';
import { create } from './create';
import { init } from './init';
import { squash } from './squash';

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

describe('squash', () => {
  it('collapses N commits into one with concatenated messages and restacks descendants', async () => {
    await create('feat/a', dir);
    await writeAndCommit(dir, 'a.txt', '1', 'feat: c1');
    await writeAndCommit(dir, 'b.txt', '2', 'feat: c2');
    await writeAndCommit(dir, 'c.txt', '3', 'feat: c3');

    await create('feat/b', dir);
    await writeAndCommit(dir, 'd.txt', '4', 'feat: child');

    await gitInRepo(dir, ['checkout', 'feat/a']);
    const result = await squash(dir, {});

    expect(result.noopReason).toBeUndefined();
    expect(result.squashedCommits).toBe(3);
    expect(result.restacked).toBe(true);

    const { stdout: log } = await gitInRepo(dir, [
      'log',
      '--format=%s',
      'main..feat/a',
    ]);
    const subjects = log.trim().split('\n');
    expect(subjects).toHaveLength(1);

    // Most-recent-first concatenation: c3 (subject) first, c1 last.
    const { stdout: msg } = await gitInRepo(dir, [
      'log',
      '-1',
      '--format=%B',
      'feat/a',
    ]);
    const body = msg.trim();
    expect(body.indexOf('feat: c3')).toBeLessThan(body.indexOf('feat: c2'));
    expect(body.indexOf('feat: c2')).toBeLessThan(body.indexOf('feat: c1'));

    // Working tree is clean post-commit.
    const { stdout: status } = await gitInRepo(dir, ['status', '--porcelain']);
    expect(status.trim()).toBe('');

    // Descendant restacked: feat/b should now sit on the new feat/a tip.
    const aTip = await getBranchTip('feat/a', dir);
    const { stdout: bParent } = await gitInRepo(dir, ['rev-parse', 'feat/b^']);
    expect(bParent.trim()).toBe(aTip);
  });

  it('is a no-op for a single commit', async () => {
    await create('feat/a', dir);
    await writeAndCommit(dir, 'a.txt', '1', 'feat: only');
    const tip = await getBranchTip('feat/a', dir);

    const result = await squash(dir, {});

    expect(result.noopReason).toBe('single-commit');
    expect(result.squashedCommits).toBe(0);
    expect(result.restacked).toBe(false);
    expect(await getBranchTip('feat/a', dir)).toBe(tip);
  });

  it('is a no-op for zero commits', async () => {
    await create('feat/empty', dir);
    const tip = await getBranchTip('feat/empty', dir);

    const result = await squash(dir, {});

    expect(result.noopReason).toBe('no-commits');
    expect(result.squashedCommits).toBe(0);
    expect(await getBranchTip('feat/empty', dir)).toBe(tip);
  });

  it('-m overrides the auto-generated message', async () => {
    await create('feat/a', dir);
    await writeAndCommit(dir, 'a.txt', '1', 'feat: c1');
    await writeAndCommit(dir, 'b.txt', '2', 'feat: c2');

    await squash(dir, { message: 'feat: combined' });

    const { stdout } = await gitInRepo(dir, [
      'log',
      '-1',
      '--format=%B',
      'feat/a',
    ]);
    expect(stdout.trim()).toBe('feat: combined');
  });

  it('refuses to squash when the working tree is dirty', async () => {
    await create('feat/a', dir);
    await writeAndCommit(dir, 'a.txt', '1', 'feat: c1');
    await writeAndCommit(dir, 'b.txt', '2', 'feat: c2');
    fs.writeFileSync(path.join(dir, 'dirty.txt'), 'dirty');

    await expect(squash(dir, {})).rejects.toThrow('uncommitted changes');
  });

  it('refuses on a branch without a tracked parent', async () => {
    await gitInRepo(dir, ['checkout', '-b', 'untracked']);
    await writeAndCommit(dir, 'a.txt', '1', 'feat: c1');
    await writeAndCommit(dir, 'b.txt', '2', 'feat: c2');

    await expect(squash(dir, {})).rejects.toThrow(
      'Could not determine parent branch',
    );
  });

  it("rejects combining '--ai' with '-m'", async () => {
    await create('feat/a', dir);
    await writeAndCommit(dir, 'a.txt', '1', 'feat: c1');
    await writeAndCommit(dir, 'b.txt', '2', 'feat: c2');

    await expect(
      squash(dir, { ai: true, message: 'override' }),
    ).rejects.toThrow("'--ai' cannot be combined with '-m'");
  });

  it("refuses '--ai' when the AI assistant is disabled", async () => {
    await create('feat/a', dir);
    await writeAndCommit(dir, 'a.txt', '1', 'feat: c1');
    await writeAndCommit(dir, 'b.txt', '2', 'feat: c2');

    const rejection = squash(dir, { ai: true });
    await expect(rejection).rejects.toBeInstanceOf(DubError);
    await expect(rejection).rejects.toThrow('AI assistant is disabled');
  });

  it('reports restacked=false for a leaf branch with no descendants', async () => {
    await create('feat/a', dir);
    await writeAndCommit(dir, 'a.txt', '1', 'feat: c1');
    await writeAndCommit(dir, 'b.txt', '2', 'feat: c2');

    const result = await squash(dir, {});

    expect(result.squashedCommits).toBe(2);
    expect(result.restacked).toBe(false);
  });

  it("uses the AI-generated message when '--ai' is supplied", async () => {
    await create('feat/a', dir);
    await writeAndCommit(dir, 'a.txt', '1', 'feat: c1');
    await writeAndCommit(dir, 'b.txt', '2', 'feat: c2');

    await writeConfig({ aiAssistantEnabled: true }, dir);

    const generateText = vi.fn().mockResolvedValue({
      text: 'feat: summarize a and b',
    });
    const resolveModel = vi.fn().mockReturnValue({} as never);
    const createGoogleGenerativeAI = vi.fn().mockReturnValue(resolveModel);
    const createGateway = vi.fn().mockReturnValue(resolveModel);
    process.env.DUBSTACK_GEMINI_API_KEY = 'test-key';

    try {
      await squash(
        dir,
        { ai: true },
        {
          generateText: generateText as never,
          createGoogleGenerativeAI: createGoogleGenerativeAI as never,
          createGateway: createGateway as never,
        },
      );
    } finally {
      delete process.env.DUBSTACK_GEMINI_API_KEY;
    }

    expect(generateText).toHaveBeenCalledTimes(1);
    const { stdout } = await gitInRepo(dir, [
      'log',
      '-1',
      '--format=%B',
      'feat/a',
    ]);
    expect(stdout.trim()).toBe('feat: summarize a and b');
  });

  it("throws when the AI assistant returns an empty message under '--ai'", async () => {
    await create('feat/a', dir);
    await writeAndCommit(dir, 'a.txt', '1', 'feat: c1');
    await writeAndCommit(dir, 'b.txt', '2', 'feat: c2');

    await writeConfig({ aiAssistantEnabled: true }, dir);

    const generateText = vi.fn().mockResolvedValue({ text: '   ' });
    const resolveModel = vi.fn().mockReturnValue({} as never);
    process.env.DUBSTACK_GEMINI_API_KEY = 'test-key';

    try {
      await expect(
        squash(
          dir,
          { ai: true },
          {
            generateText: generateText as never,
            createGoogleGenerativeAI: vi
              .fn()
              .mockReturnValue(resolveModel) as never,
            createGateway: vi.fn().mockReturnValue(resolveModel) as never,
          },
        ),
      ).rejects.toThrow('AI assistant generated an empty squash message');
    } finally {
      delete process.env.DUBSTACK_GEMINI_API_KEY;
    }
  });
});
