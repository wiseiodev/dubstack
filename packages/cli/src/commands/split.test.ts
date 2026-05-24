import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestRepo, gitInRepo } from '../../test/helpers';
import { writeConfig } from '../lib/config';
import { getBranchTip, getCurrentBranch, listCommitsBetween } from '../lib/git';
import { findStackForBranch, readState } from '../lib/state';
import { create } from './create';
import { init } from './init';
import { split } from './split';

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

async function writeAndCommit(
  file: string,
  contents: string,
  message: string,
): Promise<void> {
  fs.writeFileSync(path.join(dir, file), contents);
  await gitInRepo(dir, ['add', file]);
  await gitInRepo(dir, ['commit', '-m', message]);
}

describe('split --by-file', () => {
  it('extracts 2 of 5 files into a new sibling branch', async () => {
    await create('feat/source', dir);
    for (let i = 1; i <= 5; i++) {
      await writeAndCommit(
        `f${i}.ts`,
        `export const v${i} = ${i};\n`,
        `feat: add f${i}`,
      );
    }

    const before = await getBranchTip('feat/source', dir);
    const result = await split(dir, {
      mode: 'by-file',
      files: ['f1.ts', 'f2.ts'],
      name: 'feat/extracted',
    });

    expect(result.created).toHaveLength(1);
    expect(result.created[0].branch).toBe('feat/extracted');
    expect(result.created[0].parent).toBe('main');
    expect(await getCurrentBranch(dir)).toBe('feat/source');

    // New branch has the extracted files.
    await gitInRepo(dir, ['checkout', 'feat/extracted']);
    expect(fs.existsSync(path.join(dir, 'f1.ts'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'f2.ts'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'f3.ts'))).toBe(false);

    // Source branch dropped the extracted files in a removal commit.
    await gitInRepo(dir, ['checkout', 'feat/source']);
    expect(fs.existsSync(path.join(dir, 'f1.ts'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'f2.ts'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'f3.ts'))).toBe(true);

    const after = await getBranchTip('feat/source', dir);
    expect(after).not.toBe(before);

    const state = await readState(dir);
    const stack = findStackForBranch(state, 'feat/extracted');
    expect(stack).toBeDefined();
    expect(stack?.branches.map((b) => b.name).sort()).toEqual([
      'feat/extracted',
      'feat/source',
      'main',
    ]);
  });

  it('rejects files that are not in the branch diff', async () => {
    await create('feat/source', dir);
    await writeAndCommit('f1.ts', 'export const v1 = 1;\n', 'feat: f1');

    await expect(
      split(dir, {
        mode: 'by-file',
        files: ['f1.ts', 'f2.ts'],
        name: 'feat/extracted',
      }),
    ).rejects.toThrow("not part of 'feat/source'");
  });

  it('requires --name', async () => {
    await create('feat/source', dir);
    await writeAndCommit('f1.ts', 'export const v1 = 1;\n', 'feat: f1');

    await expect(
      split(dir, { mode: 'by-file', files: ['f1.ts'] }),
    ).rejects.toThrow("requires '--name");
  });

  it('rejects extracting onto a branch name that already exists', async () => {
    await create('feat/source', dir);
    await writeAndCommit('f1.ts', 'export const v1 = 1;\n', 'feat: f1');
    await gitInRepo(dir, ['branch', 'feat/extracted', 'main']);

    await expect(
      split(dir, {
        mode: 'by-file',
        files: ['f1.ts'],
        name: 'feat/extracted',
      }),
    ).rejects.toThrow('already exists');
  });
});

describe('split --by-commit', () => {
  it('extracts 1 of 3 commits to a new branch', async () => {
    await create('feat/source', dir);
    await writeAndCommit('a.ts', 'a1\n', 'feat: add a');
    await writeAndCommit('b.ts', 'b1\n', 'feat: add b');
    await writeAndCommit('c.ts', 'c1\n', 'feat: add c');

    const commitsBefore = await listCommitsBetween('main', 'feat/source', dir);
    expect(commitsBefore).toHaveLength(3);

    const result = await split(dir, {
      mode: 'by-commit',
      name: 'feat/extracted-b',
      commitPicks: [2],
    });

    expect(result.created).toHaveLength(1);
    expect(result.created[0].branch).toBe('feat/extracted-b');
    expect(result.created[0].commits).toHaveLength(1);

    const newBranchCommits = await listCommitsBetween(
      'main',
      'feat/extracted-b',
      dir,
    );
    expect(newBranchCommits).toHaveLength(1);
    expect(newBranchCommits[0].subject).toBe('feat: add b');

    const sourceCommits = await listCommitsBetween('main', 'feat/source', dir);
    expect(sourceCommits.map((c) => c.subject)).toEqual([
      'feat: add a',
      'feat: add c',
    ]);
  });

  it('rejects when only one commit on the branch', async () => {
    await create('feat/source', dir);
    await writeAndCommit('a.ts', 'a1\n', 'feat: add a');

    await expect(
      split(dir, { mode: 'by-commit', name: 'feat/x', commitPicks: [1] }),
    ).rejects.toThrow('only one commit');
  });

  it('rejects when picks select all or none', async () => {
    await create('feat/source', dir);
    await writeAndCommit('a.ts', 'a1\n', 'feat: add a');
    await writeAndCommit('b.ts', 'b1\n', 'feat: add b');

    await expect(
      split(dir, {
        mode: 'by-commit',
        name: 'feat/x',
        commitPicks: [1, 2],
      }),
    ).rejects.toThrow('at least one and leave at least one');
  });

  it('rejects out-of-range commitPicks', async () => {
    await create('feat/source', dir);
    await writeAndCommit('a.ts', 'a\n', 'feat: a');
    await writeAndCommit('b.ts', 'b\n', 'feat: b');

    await expect(
      split(dir, {
        mode: 'by-commit',
        name: 'feat/x',
        commitPicks: [5],
      }),
    ).rejects.toThrow('Invalid commit pick');
  });
});

describe('split --by-hunk', () => {
  it('throws clearly when the source has no diff vs parent', async () => {
    await create('feat/source', dir);
    // No commits added on feat/source.

    await expect(
      split(dir, { mode: 'by-hunk', name: 'feat/x' }),
    ).rejects.toThrow('no diff');
  });
});

describe('split --ai', () => {
  beforeEach(async () => {
    await writeConfig({ aiAssistantEnabled: true }, dir);
  });

  it('dry-run returns the proposal without touching branches', async () => {
    await create('feat/source', dir);
    await writeAndCommit('runtime.ts', 'r1\n', 'feat: runtime');
    await writeAndCommit('docs.md', 'docs\n', 'docs: notes');

    const before = await getBranchTip('feat/source', dir);

    const fakeProposal = JSON.stringify({
      splits: [
        {
          branch: 'feat/runtime',
          files: ['runtime.ts'],
          summary: 'runtime changes',
        },
        {
          branch: 'docs/notes',
          files: ['docs.md'],
          summary: 'docs only',
        },
      ],
    });
    const generateText = vi.fn().mockResolvedValueOnce({ text: fakeProposal });
    const deps = {
      generateText,
      createGoogleGenerativeAI: vi.fn().mockReturnValue(() => 'model'),
      createGateway: vi.fn(),
      createAmazonBedrock: vi.fn(),
      fromIni: vi.fn(),
      fromNodeProviderChain: vi.fn(),
    };
    process.env.DUBSTACK_GEMINI_API_KEY = 'test-key';

    const result = await split(
      dir,
      { mode: 'ai', dryRun: true, yes: true },
      // biome-ignore lint/suspicious/noExplicitAny: test-only deps shape
      deps as any,
    );

    delete process.env.DUBSTACK_GEMINI_API_KEY;

    expect(result.aiProposal).toBeDefined();
    expect(result.aiProposal).toHaveLength(2);
    expect(result.aiProposal?.[0].branch).toBe('feat/runtime');
    expect(result.created).toHaveLength(0);
    const after = await getBranchTip('feat/source', dir);
    expect(after).toBe(before);
  });

  it('applies the proposal end-to-end when --yes is set', async () => {
    await create('feat/source', dir);
    await writeAndCommit('runtime.ts', 'r1\n', 'feat: runtime');
    await writeAndCommit('docs.md', 'docs\n', 'docs: notes');

    const fakeProposal = JSON.stringify({
      splits: [
        {
          branch: 'feat/runtime',
          files: ['runtime.ts'],
          summary: 'runtime changes',
        },
        {
          branch: 'docs/notes',
          files: ['docs.md'],
          summary: 'docs only',
        },
      ],
    });
    const deps = {
      generateText: vi.fn().mockResolvedValueOnce({ text: fakeProposal }),
      createGoogleGenerativeAI: vi.fn().mockReturnValue(() => 'model'),
      createGateway: vi.fn(),
      createAmazonBedrock: vi.fn(),
      fromIni: vi.fn(),
      fromNodeProviderChain: vi.fn(),
    };
    process.env.DUBSTACK_GEMINI_API_KEY = 'test-key';

    const result = await split(
      dir,
      { mode: 'ai', yes: true },
      // biome-ignore lint/suspicious/noExplicitAny: test-only deps shape
      deps as any,
    );

    delete process.env.DUBSTACK_GEMINI_API_KEY;

    expect(result.created).toHaveLength(2);
    expect(result.created.map((c) => c.branch).sort()).toEqual([
      'docs/notes',
      'feat/runtime',
    ]);

    const state = await readState(dir);
    const branchNames = state.stacks
      .flatMap((s) => s.branches.map((b) => b.name))
      .sort();
    expect(branchNames).toContain('feat/runtime');
    expect(branchNames).toContain('docs/notes');
  });

  it('rejects AI proposals that omit files', async () => {
    await create('feat/source', dir);
    await writeAndCommit('a.ts', 'a\n', 'feat: a');
    await writeAndCommit('b.ts', 'b\n', 'feat: b');

    const fakeProposal = JSON.stringify({
      splits: [{ branch: 'feat/only-a', files: ['a.ts'], summary: 'only a' }],
    });
    const deps = {
      generateText: vi.fn().mockResolvedValueOnce({ text: fakeProposal }),
      createGoogleGenerativeAI: vi.fn().mockReturnValue(() => 'model'),
      createGateway: vi.fn(),
      createAmazonBedrock: vi.fn(),
      fromIni: vi.fn(),
      fromNodeProviderChain: vi.fn(),
    };
    process.env.DUBSTACK_GEMINI_API_KEY = 'test-key';

    await expect(
      split(
        dir,
        { mode: 'ai', yes: true },
        // biome-ignore lint/suspicious/noExplicitAny: test-only deps shape
        deps as any,
      ),
    ).rejects.toThrow('omitted');

    delete process.env.DUBSTACK_GEMINI_API_KEY;
  });
});

describe('split mode dispatch', () => {
  it('refuses to split the root branch', async () => {
    await expect(
      split(dir, { mode: 'by-file', files: ['x'], name: 'feat/x' }),
    ).rejects.toThrow('not tracked');
  });

  it('refuses when working tree is dirty', async () => {
    await create('feat/source', dir);
    await writeAndCommit('a.ts', 'a\n', 'feat: add a');
    fs.writeFileSync(path.join(dir, 'a.ts'), 'modified\n');

    await expect(
      split(dir, { mode: 'by-file', files: ['a.ts'], name: 'feat/x' }),
    ).rejects.toThrow('uncommitted changes');
  });
});

describe('split descendants', () => {
  it('restacks descendants after split', async () => {
    await create('feat/source', dir);
    await writeAndCommit('a.ts', 'a\n', 'feat: add a');
    await writeAndCommit('b.ts', 'b\n', 'feat: add b');
    await create('feat/child', dir);
    await writeAndCommit('child.ts', 'c\n', 'feat: child');

    // Switch back to source and split.
    await gitInRepo(dir, ['checkout', 'feat/source']);
    const result = await split(dir, {
      mode: 'by-file',
      files: ['a.ts'],
      name: 'feat/extracted',
    });

    expect(result.restacked).toBe(true);

    // Child should still be valid (rebased onto the new source tip).
    await gitInRepo(dir, ['checkout', 'feat/child']);
    expect(fs.existsSync(path.join(dir, 'child.ts'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'b.ts'))).toBe(true);
    // a.ts was extracted away so child no longer has it.
    expect(fs.existsSync(path.join(dir, 'a.ts'))).toBe(false);
  });
});
