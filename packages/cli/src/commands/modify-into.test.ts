import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestRepo, gitInRepo } from '../../test/helpers';
import { getCurrentBranch } from '../lib/git';
import { create } from './create';
import { init } from './init';
import { modify } from './modify';

let dir: string;
let cleanup: () => Promise<void>;

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

describe('modify --into', () => {
  it('updates an older branch and restores the original branch', async () => {
    await create('feat/a', dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'feature a\n');
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'feat(a): initial']);

    await create('feat/b', dir);
    fs.writeFileSync(path.join(dir, 'b.txt'), 'feature b\n');
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'feat(b): initial']);

    fs.appendFileSync(path.join(dir, 'a.txt'), 'hotfix\n');

    await modify(dir, {
      into: 'feat/a',
      all: true,
      commit: true,
      message: 'fix(a): apply targeted fix',
    });

    expect(await getCurrentBranch(dir)).toBe('feat/b');

    const targetLastCommit = (
      await gitInRepo(dir, ['log', '-1', '--format=%s', 'feat/a'])
    ).stdout.trim();
    expect(targetLastCommit).toBe('fix(a): apply targeted fix');

    const fileContent = fs.readFileSync(path.join(dir, 'a.txt'), 'utf8');
    expect(fileContent).toContain('hotfix');
  });
});
