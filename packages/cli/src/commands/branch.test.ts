import * as fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestRepo, gitInRepo } from '../../test/helpers';
import { branchInfo, branchInfoOutput, formatBranchInfo } from './branch';
import { create } from './create';
import { init } from './init';

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

describe('branch info', () => {
  it('returns tracked metadata for the current branch', async () => {
    await create('feat/a', dir);
    await create('feat/b', dir);

    const info = await branchInfo(dir);
    expect(info).toMatchObject({
      currentBranch: 'feat/b',
      tracked: true,
      root: 'main',
      parent: 'feat/a',
      children: [],
    });
    expect(info.stackId).toBeTruthy();
  });

  it('lists sorted children for tracked branch', async () => {
    await create('feat/a', dir);
    await gitInRepo(dir, ['checkout', 'main']);
    await create('feat/c', dir);
    await gitInRepo(dir, ['checkout', 'main']);
    await create('feat/b', dir);
    await gitInRepo(dir, ['checkout', 'main']);

    const info = await branchInfo(dir);
    expect(info.children).toEqual(['feat/a', 'feat/b', 'feat/c']);
  });

  it('returns untracked metadata for a branch outside dubstack state', async () => {
    await gitInRepo(dir, ['checkout', '-b', 'rogue']);

    const info = await branchInfo(dir);
    expect(info).toEqual({
      currentBranch: 'rogue',
      tracked: false,
      stackId: null,
      root: null,
      parent: null,
      children: [],
    });
  });

  it('returns metadata for explicitly requested branch', async () => {
    await create('feat/a', dir);
    await create('feat/b', dir);
    await gitInRepo(dir, ['checkout', 'feat/b']);

    const info = await branchInfo(dir, 'feat/a');
    expect(info).toMatchObject({
      currentBranch: 'feat/a',
      tracked: true,
      parent: 'main',
      children: ['feat/b'],
    });
  });

  it('formats tracked and untracked output for CLI display', () => {
    const tracked = formatBranchInfo({
      currentBranch: 'feat/a',
      tracked: true,
      stackId: 'stack-1',
      root: 'main',
      parent: 'main',
      children: ['feat/b'],
    });
    expect(tracked).toContain('Branch: feat/a');
    expect(tracked).toContain('Tracked: yes');
    expect(tracked).toContain('Children: feat/b');

    const untracked = formatBranchInfo({
      currentBranch: 'rogue',
      tracked: false,
      stackId: null,
      root: null,
      parent: null,
      children: [],
    });
    expect(untracked).toContain('Tracked: no');
    expect(untracked).toContain('not tracked by DubStack');
  });

  it('includes a parent-relative diff when requested', async () => {
    await create('feat/a', dir);
    await create('feat/b', dir);
    await gitInRepo(dir, ['checkout', 'feat/b']);

    await fs.promises.writeFile(`${dir}/feature.txt`, 'hello from feat/b\n');
    await gitInRepo(dir, ['add', 'feature.txt']);
    await gitInRepo(dir, ['commit', '-m', 'feat: add branch diff fixture']);

    const output = await branchInfoOutput(dir, undefined, { diff: true });
    expect(output).toContain('Branch: feat/b');
    expect(output).toContain('Diff vs feat/a:');
    expect(output).toContain('diff --git a/feature.txt b/feature.txt');
  });

  it('shows an explicit marker when there are no changes relative to the parent', async () => {
    await create('feat/a', dir);
    await create('feat/b', dir);

    const output = await branchInfoOutput(dir, undefined, { diff: true });
    expect(output).toContain('Diff vs feat/a:');
    expect(output).toContain('(no changes)');
  });

  it('explains that root branches do not have a parent-relative diff', async () => {
    await create('feat/a', dir);
    await gitInRepo(dir, ['checkout', 'main']);

    const output = await branchInfoOutput(dir, 'main', { diff: true });
    expect(output).toContain('Branch: main');
    expect(output).toContain('Diff: unavailable for stack root branches.');
  });

  it('explains that untracked branches cannot show a dubstack diff', async () => {
    await gitInRepo(dir, ['checkout', '-b', 'rogue']);

    const output = await branchInfoOutput(dir, undefined, { diff: true });
    expect(output).toContain('Branch: rogue');
    expect(output).toContain(
      'Diff: unavailable because this branch is not tracked by DubStack.',
    );
  });
});
