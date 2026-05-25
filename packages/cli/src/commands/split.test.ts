import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestRepo, gitInRepo } from '../../test/helpers';
import {
  appendCleanupOperation,
  hasCleanupJournal,
  startCleanupJournal,
} from '../lib/cleanup-journal';
import { resumeCleanup } from '../lib/cleanup-resume';
import { writeConfig } from '../lib/config';
import { getBranchTip, getCurrentBranch, listCommitsBetween } from '../lib/git';
import { findStackForBranch, readState, writeState } from '../lib/state';
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

  it('parses commit subjects that contain literal "<<<" markers', async () => {
    await create('feat/source', dir);
    // Subject with a marker that could confuse string-based separators.
    await writeAndCommit('a.ts', 'a\n', 'feat: a <<<DUB-SPLIT-SEP>>> b');
    await writeAndCommit('b.ts', 'b\n', 'feat: plain b');

    const commits = await listCommitsBetween('main', 'feat/source', dir);
    expect(commits).toHaveLength(2);
    expect(commits[0].subject).toBe('feat: a <<<DUB-SPLIT-SEP>>> b');
    expect(commits[1].subject).toBe('feat: plain b');

    // Should still split cleanly.
    const result = await split(dir, {
      mode: 'by-commit',
      name: 'feat/extracted-tricky',
      commitPicks: [1],
    });
    expect(result.created).toHaveLength(1);
    const newCommits = await listCommitsBetween(
      'main',
      'feat/extracted-tricky',
      dir,
    );
    expect(newCommits[0].subject).toBe('feat: a <<<DUB-SPLIT-SEP>>> b');
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

  it('dry-run skips the AI call and returns no proposal', async () => {
    // Per DUB-70 (Copilot review on split.ts:286): `--ai --dry-run` must
    // bail BEFORE invoking the AI provider so previews never bill. The
    // result intentionally omits `aiProposal` — callers who want the
    // model's proposed shape re-run without --dry-run.
    await create('feat/source', dir);
    await writeAndCommit('runtime.ts', 'r1\n', 'feat: runtime');
    await writeAndCommit('docs.md', 'docs\n', 'docs: notes');

    const before = await getBranchTip('feat/source', dir);
    const generateText = vi.fn().mockImplementation(() => {
      throw new Error('AI provider must not be called in dry-run');
    });
    const deps = {
      generateText,
      createGoogleGenerativeAI: vi.fn().mockReturnValue(() => 'model'),
      createGateway: vi.fn(),
      createAmazonBedrock: vi.fn(),
      fromIni: vi.fn(),
      fromNodeProviderChain: vi.fn(),
    };

    const result = await split(
      dir,
      { mode: 'ai', dryRun: true, yes: true },
      // biome-ignore lint/suspicious/noExplicitAny: test-only deps shape
      deps as any,
    );

    expect(generateText).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
    expect(result.aiProposal).toBeUndefined();
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

  it('rejects AI proposals that propose the same branch name twice', async () => {
    await create('feat/source', dir);
    await writeAndCommit('a.ts', 'a\n', 'feat: a');
    await writeAndCommit('b.ts', 'b\n', 'feat: b');

    const fakeProposal = JSON.stringify({
      splits: [
        { branch: 'feat/dupe', files: ['a.ts'], summary: 's1' },
        { branch: 'feat/dupe', files: ['b.ts'], summary: 's2' },
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
    await expect(
      split(
        dir,
        { mode: 'ai', yes: true },
        // biome-ignore lint/suspicious/noExplicitAny: test-only deps shape
        deps as any,
      ),
    ).rejects.toThrow("same branch name 'feat/dupe' more than once");
    delete process.env.DUBSTACK_GEMINI_API_KEY;

    // Neither branch should have been created.
    const state = await readState(dir);
    const names = state.stacks.flatMap((s) => s.branches.map((b) => b.name));
    expect(names).not.toContain('feat/dupe');
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

describe('split journal integration', () => {
  it('clears the cleanup journal after a successful split', async () => {
    await create('feat/source', dir);
    fs.writeFileSync(path.join(dir, 'x.ts'), 'x\n');
    await gitInRepo(dir, ['add', 'x.ts']);
    await gitInRepo(dir, ['commit', '-m', 'feat: add x']);
    fs.writeFileSync(path.join(dir, 'y.ts'), 'y\n');
    await gitInRepo(dir, ['add', 'y.ts']);
    await gitInRepo(dir, ['commit', '-m', 'feat: add y']);

    expect(await hasCleanupJournal(dir)).toBe(false);
    await split(dir, {
      mode: 'by-file',
      files: ['x.ts'],
      name: 'feat/extracted',
    });
    // Clean exit must clear the journal so the next `dub split` is not
    // blocked by the hasCleanupJournal preflight.
    expect(await hasCleanupJournal(dir)).toBe(false);
  });

  it('refuses to start when an unrelated cleanup journal is on disk', async () => {
    await create('feat/source', dir);
    fs.writeFileSync(path.join(dir, 'a.ts'), 'a\n');
    await gitInRepo(dir, ['add', 'a.ts']);
    await gitInRepo(dir, ['commit', '-m', 'feat: a']);

    const j = await startCleanupJournal(dir);
    await appendCleanupOperation(dir, j, {
      type: 'delete',
      branch: 'something-else',
      reason: 'merged-pr',
    });

    await expect(
      split(dir, {
        mode: 'by-file',
        files: ['a.ts'],
        name: 'feat/extracted',
      }),
    ).rejects.toThrow('pending DubStack cleanup');
    // No git side-effects from the refused split.
    const state = await readState(dir);
    const names = state.stacks.flatMap((s) => s.branches.map((b) => b.name));
    expect(names).not.toContain('feat/extracted');
  });

  it('dub continue (resumeCleanup) reconciles state after a crash between branch creation and state write', async () => {
    // Simulate the precise crash window: the split extractor created the new
    // branch in git AND appended the track-branch op AND completed both git
    // commits, but the process died before writeState landed. We forge that
    // state shape by hand and prove resumeCleanup repairs it idempotently.
    await create('feat/source', dir);
    fs.writeFileSync(path.join(dir, 'lost.ts'), 'lost\n');
    await gitInRepo(dir, ['add', 'lost.ts']);
    await gitInRepo(dir, ['commit', '-m', 'feat: lost']);

    const parentTip = await getBranchTip('main', dir);
    // Create the orphan branch directly in git (mirrors createBranchFrom
    // + commitStaged having run successfully).
    await gitInRepo(dir, ['checkout', '-b', 'feat/orphan', parentTip]);
    fs.writeFileSync(path.join(dir, 'lost.ts'), 'lost\n');
    await gitInRepo(dir, ['add', 'lost.ts']);
    await gitInRepo(dir, ['commit', '-m', 'split: extract 1 file(s)']);
    await gitInRepo(dir, ['checkout', 'feat/source']);

    // Confirm state DOES NOT know about feat/orphan yet (the writeState
    // that would normally happen never did).
    const stateBefore = await readState(dir);
    const namesBefore = stateBefore.stacks
      .flatMap((s) => s.branches.map((b) => b.name))
      .sort();
    expect(namesBefore).not.toContain('feat/orphan');

    // Forge the journal entry that would have been written before the crash.
    const j = await startCleanupJournal(dir);
    await appendCleanupOperation(dir, j, {
      type: 'split-track-branch',
      branch: 'feat/orphan',
      parent: 'main',
      parentTip,
      sourceBranch: 'feat/source',
    });

    const result = await resumeCleanup(dir);

    expect(result.applied).toHaveLength(1);
    expect(result.applied[0].type).toBe('split-track-branch');

    const stateAfter = await readState(dir);
    const namesAfter = stateAfter.stacks
      .flatMap((s) => s.branches.map((b) => b.name))
      .sort();
    expect(namesAfter).toContain('feat/orphan');
    // Journal cleared after replay so the next dub command isn't blocked.
    expect(await hasCleanupJournal(dir)).toBe(false);
  });

  it('dub continue replays idempotently — second call is a no-op', async () => {
    await create('feat/source', dir);
    fs.writeFileSync(path.join(dir, 'x.ts'), 'x\n');
    await gitInRepo(dir, ['add', 'x.ts']);
    await gitInRepo(dir, ['commit', '-m', 'feat: x']);
    const parentTip = await getBranchTip('main', dir);

    await gitInRepo(dir, ['checkout', '-b', 'feat/orphan', parentTip]);
    fs.writeFileSync(path.join(dir, 'x.ts'), 'x\n');
    await gitInRepo(dir, ['add', 'x.ts']);
    await gitInRepo(dir, ['commit', '-m', 'split: extract']);
    await gitInRepo(dir, ['checkout', 'feat/source']);

    const j = await startCleanupJournal(dir);
    await appendCleanupOperation(dir, j, {
      type: 'split-track-branch',
      branch: 'feat/orphan',
      parent: 'main',
      parentTip,
      sourceBranch: 'feat/source',
    });

    const first = await resumeCleanup(dir);
    expect(first.applied).toHaveLength(1);

    // Re-forge an identical journal (since the first replay cleared it) and
    // confirm a second pass is a no-op.
    const j2 = await startCleanupJournal(dir);
    await appendCleanupOperation(dir, j2, {
      type: 'split-track-branch',
      branch: 'feat/orphan',
      parent: 'main',
      parentTip,
      sourceBranch: 'feat/source',
    });
    const second = await resumeCleanup(dir);
    expect(second.applied).toHaveLength(0);
    expect(second.alreadyApplied).toHaveLength(1);
  });

  // Note: there is no end-to-end test that fires `split-clear-source-pr`
  // through `split()` itself. That path requires `sourceEmpty === true`, which
  // means the source branch's git tip SHA must equal the parent tip SHA after
  // the split. The extractors all append a "drop"/"remaining commits"/"retain
  // hunks" commit on source whenever there is any net diff, so the resulting
  // source tip is a fresh SHA — content can be equivalent to parent but the
  // SHA is never identical. The path stays as a defensive net for a future
  // extractor that does not commit on source (e.g. an "extract entire branch"
  // mode); the replay handler is fully covered in cleanup-resume.test.ts and
  // by the direct forged-crash test below.

  it('split-clear-source-pr replay re-nulls pr_number after a forged crash', async () => {
    // Forge the precise crash window: journal has the clear-source-pr op,
    // but state still has the pr_number set. Replay must reconcile.
    await create('feat/source', dir);
    const stateBefore = await readState(dir);
    const sourceMeta = stateBefore.stacks[0].branches.find(
      (b) => b.name === 'feat/source',
    );
    if (sourceMeta) {
      sourceMeta.pr_number = 77;
      sourceMeta.pr_link = 'https://github.com/x/y/pull/77';
    }
    await writeState(stateBefore, dir);

    const j = await startCleanupJournal(dir);
    await appendCleanupOperation(dir, j, {
      type: 'split-clear-source-pr',
      branch: 'feat/source',
    });

    const result = await resumeCleanup(dir);
    expect(result.applied).toHaveLength(1);

    const stateAfter = await readState(dir);
    const refreshedSource = stateAfter.stacks
      .flatMap((s) => s.branches)
      .find((b) => b.name === 'feat/source');
    expect(refreshedSource?.pr_number).toBeNull();
    expect(refreshedSource?.pr_link).toBeNull();
    expect(await hasCleanupJournal(dir)).toBe(false);
  });
});
