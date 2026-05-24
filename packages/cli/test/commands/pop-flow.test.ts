import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { create } from '../../src/commands/create';
import { init } from '../../src/commands/init';
import { modify } from '../../src/commands/modify';
import { pop } from '../../src/commands/pop';
import { getBranchTip, hasStagedChanges } from '../../src/lib/git';
import { createTestRepo, gitInRepo } from '../helpers';

let dir: string;
let cleanup: () => Promise<void>;

async function commitFile(
  filename: string,
  contents: string,
  message: string,
): Promise<void> {
  fs.writeFileSync(path.join(dir, filename), contents);
  await gitInRepo(dir, ['add', '.']);
  await gitInRepo(dir, ['commit', '-m', message]);
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

describe('pop + modify lazy restack of descendants', () => {
  it('pop on a middle branch, edit, modify -ac: descendant rebases onto rewritten parent', async () => {
    // main → feat/parent → feat/child
    await create('feat/parent', dir);
    await commitFile('parent.txt', 'v1', 'parent: original');

    await create('feat/child', dir);
    await commitFile('child.txt', 'child', 'child: c1');
    const originalChildTip = await getBranchTip('feat/child', dir);

    // Go back to parent and pop the one commit.
    await gitInRepo(dir, ['checkout', 'feat/parent']);
    await pop(dir, {});

    expect(await hasStagedChanges(dir)).toBe(true);

    // Edit the file then create a new commit. modify auto-restacks descendants.
    fs.writeFileSync(path.join(dir, 'parent.txt'), 'v2');
    await gitInRepo(dir, ['add', 'parent.txt']);
    await modify(dir, { commit: true, message: 'parent: edited' });

    const newParentTip = await getBranchTip('feat/parent', dir);

    // Child should now sit on top of the rewritten parent — different tip,
    // and the new parent commit must be in its history.
    const newChildTip = await getBranchTip('feat/child', dir);
    expect(newChildTip).not.toBe(originalChildTip);

    const { stdout: childLog } = await gitInRepo(dir, [
      'log',
      '--pretty=%H',
      'feat/child',
    ]);
    expect(childLog).toContain(newParentTip);

    // child.txt content must remain after we check it out.
    await gitInRepo(dir, ['checkout', 'feat/child']);
    expect(fs.readFileSync(path.join(dir, 'child.txt'), 'utf-8')).toBe('child');
  });
});
