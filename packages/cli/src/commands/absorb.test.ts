import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestRepo, gitInRepo } from '../../test/helpers';
import { getBranchTip } from '../lib/git';
import {
  hasAbsorbProgress,
  hasGitRebaseInProgress,
} from '../lib/operation-state';
import { readState } from '../lib/state';
import { abortCommand } from './abort';
import { absorb } from './absorb';
import { continueCommand } from './continue';
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

async function commitFile(
  filename: string,
  contents: string,
  message: string,
): Promise<void> {
  fs.writeFileSync(path.join(dir, filename), contents);
  await gitInRepo(dir, ['add', '.']);
  await gitInRepo(dir, ['commit', '-m', message]);
}

describe('absorb (default — git-native autosquash)', () => {
  it('returns 0 absorbed when there are no fixup commits', async () => {
    await create('feat/a', dir);
    await commitFile('a.txt', 'a', 'feat: add a');

    const result = await absorb(dir);

    expect(result.mode).toBe('auto');
    expect(result.absorbed).toBe(0);
    expect(result.conflict).toBe(false);
  });

  it('autosquashes a fixup! commit into its target on the same branch', async () => {
    await create('feat/a', dir);
    await commitFile('a.txt', 'a', 'feat: add a');
    await commitFile('b.txt', 'b', 'feat: add b');
    await commitFile('a.txt', 'a-fixed', 'fixup! feat: add a');

    const before = await gitInRepo(dir, [
      'rev-list',
      '--count',
      'main..feat/a',
    ]);
    expect(before.stdout.trim()).toBe('3');

    const result = await absorb(dir);

    expect(result.mode).toBe('auto');
    expect(result.absorbed).toBe(1);
    expect(result.conflict).toBe(false);

    const after = await gitInRepo(dir, ['rev-list', '--count', 'main..feat/a']);
    expect(after.stdout.trim()).toBe('2');
    const tip = (await gitInRepo(dir, ['log', '-2', '--format=%s'])).stdout;
    expect(tip).toContain('feat: add b');
    expect(tip).toContain('feat: add a');
    expect(tip).not.toContain('fixup!');
  });

  it('dry-run reports the count without mutating', async () => {
    await create('feat/a', dir);
    await commitFile('a.txt', 'a', 'feat: add a');
    await commitFile('a.txt', 'a-fixed', 'fixup! feat: add a');

    const tipBefore = await getBranchTip('feat/a', dir);
    const result = await absorb(dir, { dryRun: true });

    expect(result.absorbed).toBe(1);
    const tipAfter = await getBranchTip('feat/a', dir);
    expect(tipAfter).toBe(tipBefore);
  });

  it('fails clearly when run on a root branch', async () => {
    await expect(absorb(dir)).rejects.toThrow(/not part of any stack/);
  });
});

describe('absorb --ai', () => {
  it('throws when no AI provider is configured and there are WIP commits', async () => {
    await create('feat/a', dir);
    await commitFile('a.txt', 'a', 'feat: add a');
    // A WIP-looking commit: short, no Conventional Commit prefix, single file.
    await commitFile('a.txt', 'tweak', 'wip');

    const previousKeys = {
      gemini: process.env.DUBSTACK_GEMINI_API_KEY,
      gateway: process.env.DUBSTACK_AI_GATEWAY_API_KEY,
      bedrock: process.env.DUBSTACK_BEDROCK_AWS_REGION,
    };
    process.env.DUBSTACK_GEMINI_API_KEY = '';
    process.env.DUBSTACK_AI_GATEWAY_API_KEY = '';
    process.env.DUBSTACK_BEDROCK_AWS_REGION = '';

    try {
      await expect(absorb(dir, { ai: true })).rejects.toThrow(
        /has no configured provider/,
      );
    } finally {
      process.env.DUBSTACK_GEMINI_API_KEY = previousKeys.gemini;
      process.env.DUBSTACK_AI_GATEWAY_API_KEY = previousKeys.gateway;
      process.env.DUBSTACK_BEDROCK_AWS_REGION = previousKeys.bedrock;
    }
  });

  it('returns 0 absorbed when no WIP-style commits exist', async () => {
    await create('feat/a', dir);
    await commitFile('a.txt', 'a', 'feat: add a long descriptive message');
    await commitFile('b.txt', 'b', 'feat: add b with proper description');

    const result = await absorb(dir, { ai: true });
    expect(result.absorbed).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it('uses the injected provider to pick targets and folds WIPs in', async () => {
    await create('feat/a', dir);
    await commitFile('a.txt', 'a', 'feat: add a');
    await commitFile('b.txt', 'b', 'feat: add b');
    // WIP-shaped commit: subject ≤ 50 chars, no Conventional Commit prefix,
    // single-file diff touching only b.txt.
    await commitFile('b.txt', 'b-fixed', 'wip');

    const shaList = (
      await gitInRepo(dir, ['log', '--reverse', '--format=%h', 'main..feat/a'])
    ).stdout
      .split('\n')
      .filter(Boolean);
    expect(shaList).toHaveLength(3);
    const targetShort = shaList[1];
    const wipShort = shaList[2];

    const fakeDeps = makeFakeAiDeps({
      assignments: [{ wipSha: wipShort, targetSha: targetShort }],
    });

    const before = await gitInRepo(dir, [
      'rev-list',
      '--count',
      'main..feat/a',
    ]);
    expect(before.stdout.trim()).toBe('3');

    const previousKey = process.env.DUBSTACK_GEMINI_API_KEY;
    process.env.DUBSTACK_GEMINI_API_KEY = 'test-key';
    let result: Awaited<ReturnType<typeof absorb>>;
    try {
      result = await absorb(dir, { ai: true }, fakeDeps);
    } finally {
      process.env.DUBSTACK_GEMINI_API_KEY = previousKey;
    }

    expect(result.mode).toBe('ai');
    expect(result.absorbed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.conflict).toBe(false);

    const after = await gitInRepo(dir, ['rev-list', '--count', 'main..feat/a']);
    expect(after.stdout.trim()).toBe('2');
  });
});

describe('absorb --stack (cross-branch)', () => {
  it('returns 0 when no cross-branch fixups are detected', async () => {
    await create('feat/a', dir);
    await commitFile('a.txt', 'a', 'feat: add a');
    await create('feat/b', dir);
    await commitFile('b.txt', 'b', 'feat: add b');

    const result = await absorb(dir, { stack: true });
    expect(result.absorbed).toBe(0);
    expect(result.movedTo).toEqual([]);
  });

  it('moves a fixup on a child branch to its target on the parent branch', async () => {
    await create('feat/a', dir);
    await commitFile('a.txt', 'a', 'feat: add a');
    await create('feat/b', dir);
    await commitFile('b.txt', 'b', 'feat: add b');
    // A fixup on feat/b pointing at the commit subject that lives on feat/a.
    await commitFile('a.txt', 'a-fixed', 'fixup! feat: add a');

    const result = await absorb(dir, { stack: true });

    expect(result.mode).toBe('stack');
    expect(result.absorbed).toBe(1);
    expect(result.movedTo).toEqual(['feat/a']);
    expect(result.conflict).toBe(false);

    // feat/b no longer carries the fixup commit.
    const bLog = (await gitInRepo(dir, ['log', '--format=%s', 'main..feat/b']))
      .stdout;
    expect(bLog).not.toContain('fixup!');

    // feat/a's target commit absorbed the fix (file content is the fixed
    // version, and the fixup commit is gone from history).
    const aLog = (await gitInRepo(dir, ['log', '--format=%s', 'main..feat/a']))
      .stdout;
    expect(aLog).not.toContain('fixup!');
    await gitInRepo(dir, ['checkout', 'feat/a']);
    const aContent = fs.readFileSync(path.join(dir, 'a.txt'), 'utf-8');
    expect(aContent).toBe('a-fixed');
  });
});

describe('absorb conflict resume', () => {
  it('pauses with recovery hints on conflict and resumes via dub continue', async () => {
    await create('feat/a', dir);
    await commitFile('a.txt', 'a', 'feat: add a');
    // Two commits on feat/a that touch the same line — the second will
    // conflict when we try to reorder it as a fixup of the first.
    await commitFile('a.txt', 'a2', 'feat: tweak a');
    // The fixup! commit reverts a.txt to a totally different value, which
    // will conflict when applied as a fixup of the original "feat: add a".
    fs.writeFileSync(path.join(dir, 'a.txt'), 'conflicted');
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'fixup! feat: add a']);

    const result = await absorb(dir);
    expect(result.conflict).toBe(true);
    expect(await hasAbsorbProgress(dir)).toBe(true);

    // Autosquash on a single shared file can cascade through multiple
    // 3-way-merge conflicts. Resolve each one with a distinct value so
    // `git rebase --continue` doesn't refuse to record a no-op commit, then
    // re-enter `dub continue` until the rebase finishes.
    let resolvedCount = 0;
    while (await hasGitRebaseInProgress(dir)) {
      resolvedCount += 1;
      if (resolvedCount > 5) throw new Error('conflict cascade did not settle');
      const conflicted = (
        await gitInRepo(dir, ['diff', '--name-only', '--diff-filter=U'])
      ).stdout
        .split('\n')
        .filter(Boolean);
      for (const f of conflicted) {
        fs.writeFileSync(path.join(dir, f), `resolved-${resolvedCount}`);
        await gitInRepo(dir, ['add', f]);
      }
      try {
        await continueCommand(dir);
      } catch (err) {
        // Each continueCommand pass either finishes or hits the next
        // conflict; surface non-conflict failures.
        if (!(await hasGitRebaseInProgress(dir))) throw err;
      }
    }

    expect(await hasAbsorbProgress(dir)).toBe(false);
    // Confirm the absorb actually finished: the fixup got folded in and the
    // branch no longer carries the literal fixup! commit.
    const finalLog = (
      await gitInRepo(dir, ['log', '--format=%s', 'main..feat/a'])
    ).stdout;
    expect(finalLog).not.toContain('fixup!');
  });

  it('dub abort clears absorb progress and aborts the rebase', async () => {
    await create('feat/a', dir);
    await commitFile('a.txt', 'a', 'feat: add a');
    await commitFile('a.txt', 'a2', 'feat: tweak a');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'conflicted');
    await gitInRepo(dir, ['add', '.']);
    await gitInRepo(dir, ['commit', '-m', 'fixup! feat: add a']);

    const result = await absorb(dir);
    expect(result.conflict).toBe(true);
    expect(await hasAbsorbProgress(dir)).toBe(true);

    const aborted = await abortCommand(dir);
    expect(aborted.aborted).toBe('absorb');
    expect(await hasAbsorbProgress(dir)).toBe(false);
  });
});

describe('absorb option validation', () => {
  it('rejects --ai combined with --stack', async () => {
    await create('feat/a', dir);
    await expect(absorb(dir, { ai: true, stack: true })).rejects.toThrow(
      /cannot be combined/,
    );
  });

  it('rejects a dirty working tree', async () => {
    await create('feat/a', dir);
    fs.writeFileSync(path.join(dir, 'dirty.txt'), 'dirty');
    await expect(absorb(dir)).rejects.toThrow(/uncommitted changes/);
  });

  it('writes an undo entry before running', async () => {
    await create('feat/a', dir);
    await commitFile('a.txt', 'a', 'feat: add a');
    await commitFile('a.txt', 'a-fixed', 'fixup! feat: add a');

    const tipBefore = await getBranchTip('feat/a', dir);
    await absorb(dir);
    const state = await readState(dir);
    expect(state.stacks.length).toBeGreaterThan(0);
    // tip should have changed (absorb folded the fixup)
    const tipAfter = await getBranchTip('feat/a', dir);
    expect(tipAfter).not.toBe(tipBefore);
  });

  it('surfaces a deferred-restack conflict as conflict:true (auto mode)', async () => {
    // feat/a → child feat/b created *before* the fixup, then fixup added on
    // feat/a. After absorb folds the fixup, restacking feat/b replays its
    // patch onto the rewritten parent and produces a 3-way merge conflict.
    await create('feat/a', dir);
    await commitFile('shared.txt', 'a-line\n', 'feat: add a');
    await create('feat/b', dir);
    await commitFile('shared.txt', 'b-edit\n', 'feat: tweak shared on b');
    await gitInRepo(dir, ['checkout', 'feat/a']);
    await commitFile('shared.txt', 'a-line-fixed\n', 'fixup! feat: add a');

    const result = await absorb(dir);
    expect(result.conflict).toBe(true);
    // Absorb-progress is cleared so the next `dub continue` resumes the
    // restack, not the already-finished absorb.
    expect(await hasAbsorbProgress(dir)).toBe(false);
  });

  it('--ai discards a target that is not in the candidate list', async () => {
    await create('feat/a', dir);
    await commitFile('a.txt', 'a', 'feat: add a');
    await commitFile('b.txt', 'b', 'feat: add b');
    await commitFile('b.txt', 'b-fixed', 'wip');

    const fakeDeps = makeFakeAiDeps({
      // The AI hallucinates a SHA that is not in the candidates list.
      assignments: [{ wipSha: 'abc1234', targetSha: 'deadbee' }],
    });

    const previousKey = process.env.DUBSTACK_GEMINI_API_KEY;
    process.env.DUBSTACK_GEMINI_API_KEY = 'test-key';
    try {
      const result = await absorb(dir, { ai: true }, fakeDeps);
      expect(result.absorbed).toBe(0);
      // The single WIP commit was returned with targetSha:null, so it is
      // counted as skipped rather than silently reordered.
      expect(result.skipped).toBe(1);
    } finally {
      process.env.DUBSTACK_GEMINI_API_KEY = previousKey;
    }
  });

  it('--ai rejects a target that is not strictly earlier than the WIP', async () => {
    await create('feat/a', dir);
    await commitFile('a.txt', 'a', 'feat: add a');
    // Second commit is also "non-WIP-shaped" (long subject, conventional).
    await commitFile('b.txt', 'b', 'feat: add b with a long description');
    // WIP commit at index 2. AI will be told to point it at "feat: add b"
    // (index 1), which is correctly earlier — that should succeed.
    await commitFile('b.txt', 'b-fixed', 'wip');

    const log = (
      await gitInRepo(dir, ['log', '--reverse', '--format=%h', 'main..feat/a'])
    ).stdout
      .split('\n')
      .filter(Boolean);
    const earlierTarget = log[1];

    const fakeDeps = makeFakeAiDeps({
      assignments: [{ wipSha: log[2], targetSha: earlierTarget }],
    });

    const previousKey = process.env.DUBSTACK_GEMINI_API_KEY;
    process.env.DUBSTACK_GEMINI_API_KEY = 'test-key';
    try {
      const result = await absorb(dir, { ai: true }, fakeDeps);
      expect(result.absorbed).toBe(1);
    } finally {
      process.env.DUBSTACK_GEMINI_API_KEY = previousKey;
    }
  });
});

type GenerateTextResult = { text: string };
type FakeGenerateText = (input: {
  model: unknown;
  system?: string;
  prompt?: string;
}) => Promise<GenerateTextResult>;

function makeFakeAiDeps(input: {
  assignments: Array<{ wipSha: string; targetSha: string | null }>;
}) {
  const fakeGenerateText: FakeGenerateText = async () => ({
    text: JSON.stringify({ assignments: input.assignments }),
  });
  const fakeProvider = (() => ({})) as unknown as never;
  return {
    generateText:
      fakeGenerateText as unknown as typeof import('ai').generateText,
    createGoogleGenerativeAI: (() => fakeProvider) as never,
    createGateway: (() => fakeProvider) as never,
    createAmazonBedrock: undefined,
    fromIni: undefined,
    fromNodeProviderChain: undefined,
    readConfig: (async () => ({
      ai: {
        defaults: {
          createMetadata: false,
          submitDescription: false,
          flow: false,
        },
        provider: {
          selected: 'gemini' as const,
          models: {
            gemini: 'gemini-test',
            anthropic: null,
            gateway: null,
            bedrock: null,
            openai: null,
            ollama: null,
          },
        },
        shortcutFallback: {
          enabled: false,
          typoGuard: 'interactive' as const,
          nonTtyPolicy: 'error-with-suggestion' as const,
        },
        context: { shellHistory: { enabled: false, maxCommands: 0 } },
        webBrowsing: {
          mode: 'model-native' as const,
          fallback: 'graceful' as const,
        },
      },
      aiAssistantEnabled: false,
      mcpMode: 'interactive' as const,
    })) as unknown as typeof import('../lib/config').readConfig,
  };
}
