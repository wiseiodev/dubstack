import { readFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/git.js', () => ({
  getBranchTip: vi.fn(),
  getCurrentBranch: vi.fn(),
  getDiff: vi.fn(),
  getDiffBetween: vi.fn(),
  getLastCommitMessage: vi.fn(),
  pushBranch: vi.fn(),
}));

vi.mock('../lib/github.js', () => ({
  ensureGhInstalled: vi.fn(),
  checkGhAuth: vi.fn(),
  getPr: vi.fn(),
  createPr: vi.fn(),
  updatePrBody: vi.fn(),
}));

vi.mock('../lib/state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/state.js')>();
  return {
    ...actual,
    readState: vi.fn(),
    writeState: vi.fn(),
  };
});

vi.mock('../lib/config.js', () => ({
  readConfig: vi.fn(),
}));

vi.mock('../lib/metadata-templates.js', () => ({
  readMetadataTemplates: vi.fn(),
}));

import { readConfig } from '../lib/config';
import {
  getBranchTip,
  getCurrentBranch,
  getDiff,
  getDiffBetween,
  getLastCommitMessage,
  pushBranch,
} from '../lib/git';
import {
  checkGhAuth,
  createPr,
  ensureGhInstalled,
  getPr,
  updatePrBody,
} from '../lib/github';
import { readMetadataTemplates } from '../lib/metadata-templates';
import type { DubState } from '../lib/state';
import { readState, writeState } from '../lib/state';
import { resolveScope, submit } from './submit';

const mockGetCurrentBranch = getCurrentBranch as ReturnType<typeof vi.fn>;
const mockGetBranchTip = getBranchTip as ReturnType<typeof vi.fn>;
const mockGetDiff = getDiff as ReturnType<typeof vi.fn>;
const mockGetDiffBetween = getDiffBetween as ReturnType<typeof vi.fn>;
const mockGetLastCommitMessage = getLastCommitMessage as ReturnType<
  typeof vi.fn
>;
const mockPushBranch = pushBranch as ReturnType<typeof vi.fn>;
const mockEnsureGhInstalled = ensureGhInstalled as ReturnType<typeof vi.fn>;
const mockCheckGhAuth = checkGhAuth as ReturnType<typeof vi.fn>;
const mockGetPr = getPr as ReturnType<typeof vi.fn>;
const mockCreatePr = createPr as ReturnType<typeof vi.fn>;
const mockUpdatePrBody = updatePrBody as ReturnType<typeof vi.fn>;
const mockReadState = readState as ReturnType<typeof vi.fn>;
const mockWriteState = writeState as ReturnType<typeof vi.fn>;
const mockReadConfig = readConfig as ReturnType<typeof vi.fn>;
const mockReadMetadataTemplates = readMetadataTemplates as ReturnType<
  typeof vi.fn
>;

function makeConfig(overrides?: {
  aiAssistantEnabled?: boolean;
  submitDescription?: boolean;
}) {
  return {
    aiAssistantEnabled: overrides?.aiAssistantEnabled ?? false,
    ai: {
      defaults: {
        createMetadata: false,
        submitDescription: overrides?.submitDescription ?? false,
        flow: false,
      },
      provider: {
        selected: 'auto' as const,
        models: {
          gemini: null,
          gateway: null,
          bedrock: null,
        },
      },
      shortcutFallback: {
        enabled: true,
        typoGuard: 'interactive' as const,
        nonTtyPolicy: 'error-with-suggestion' as const,
      },
      context: {
        shellHistory: {
          enabled: true,
          maxCommands: 200,
        },
      },
      webBrowsing: {
        mode: 'model-native' as const,
        fallback: 'graceful' as const,
      },
    },
  };
}

function makeState(
  branches: {
    name: string;
    parent: string | null;
    type?: 'root';
    parent_revision?: string;
  }[],
): DubState {
  return {
    stacks: [
      {
        id: 'stack-uuid',
        branches: branches.map((b) => ({
          ...b,
          pr_number: null,
          pr_link: null,
        })),
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnsureGhInstalled.mockResolvedValue(undefined);
  mockCheckGhAuth.mockResolvedValue(undefined);
  mockReadConfig.mockResolvedValue(makeConfig());
  mockWriteState.mockResolvedValue(undefined);
  mockPushBranch.mockResolvedValue(undefined);
  mockGetBranchTip.mockImplementation(
    async (branch: string) => `${branch}-sha`,
  );
  mockGetDiff.mockResolvedValue('diff --git a/file.ts b/file.ts');
  mockGetDiffBetween.mockResolvedValue('diff --git a/file.ts b/file.ts');
  mockGetLastCommitMessage.mockResolvedValue('feat: existing title');
  mockUpdatePrBody.mockResolvedValue(undefined);
  mockReadMetadataTemplates.mockResolvedValue({
    prTemplate: null,
    commitTemplate: null,
  });
});

describe('submit', () => {
  it('uses the repo default to enable AI PR descriptions when no flag is passed', async () => {
    mockReadConfig.mockResolvedValue(
      makeConfig({ aiAssistantEnabled: true, submitDescription: true }),
    );
    process.env.DUBSTACK_GEMINI_API_KEY = 'gem-key';
    mockGetCurrentBranch.mockResolvedValue('feat/a');
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
      ]),
    );
    mockGetPr.mockResolvedValue({
      number: 42,
      url: 'https://github.com/o/r/pull/42',
      title: 'feat: existing title',
      body: 'User intro',
    });
    const generateText = vi.fn().mockResolvedValue({
      text: '## Summary\n\nGenerated PR description',
    });
    const googleModel = vi.fn().mockReturnValue('google-model');
    const createGoogleGenerativeAI = vi.fn().mockReturnValue(googleModel);
    const createGateway = vi.fn();
    let updatedBody = '';
    mockUpdatePrBody.mockImplementationOnce(async (_number, bodyFile) => {
      updatedBody = await readFile(bodyFile, 'utf8');
    });

    await submit(
      '/repo',
      false,
      {},
      {
        generateText,
        createGoogleGenerativeAI,
        createGateway,
      },
    );

    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'google-model',
      }),
    );
    expect(updatedBody).toContain('Generated PR description');
    expect(updatedBody).toContain('User intro');
  });

  it('allows --no-ai to override an enabled repo default', async () => {
    mockReadConfig.mockResolvedValue(
      makeConfig({ aiAssistantEnabled: true, submitDescription: true }),
    );
    mockGetCurrentBranch.mockResolvedValue('feat/a');
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
      ]),
    );
    mockGetPr.mockResolvedValue({
      number: 42,
      url: 'https://github.com/o/r/pull/42',
      title: 'feat: existing title',
      body: 'User intro',
    });
    const generateText = vi.fn();
    const createGoogleGenerativeAI = vi.fn();
    const createGateway = vi.fn();

    await submit(
      '/repo',
      false,
      { noAi: true },
      {
        generateText,
        createGoogleGenerativeAI,
        createGateway,
      },
    );

    expect(generateText).not.toHaveBeenCalled();
  });

  it('preserves user-authored body content and replaces only the ai-managed summary', async () => {
    mockReadConfig.mockResolvedValue(makeConfig({ aiAssistantEnabled: true }));
    process.env.DUBSTACK_GEMINI_API_KEY = 'gem-key';
    mockGetCurrentBranch.mockResolvedValue('feat/a');
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
      ]),
    );
    mockGetPr.mockResolvedValue({
      number: 42,
      url: 'https://github.com/o/r/pull/42',
      title: 'feat: existing title',
      body: [
        'User intro',
        '',
        '<!-- dubstack-ai-summary:start -->',
        'Old summary',
        '<!-- dubstack-ai-summary:end -->',
        '',
        'Extra note',
      ].join('\n'),
    });
    const generateText = vi.fn().mockResolvedValue({
      text: 'New generated summary',
    });
    const googleModel = vi.fn().mockReturnValue('google-model');
    const createGoogleGenerativeAI = vi.fn().mockReturnValue(googleModel);
    const createGateway = vi.fn();
    let updatedBody = '';
    mockUpdatePrBody.mockImplementationOnce(async (_number, bodyFile) => {
      updatedBody = await readFile(bodyFile, 'utf8');
    });

    await submit(
      '/repo',
      false,
      { ai: true },
      {
        generateText,
        createGoogleGenerativeAI,
        createGateway,
      },
    );

    expect(updatedBody).toContain('User intro');
    expect(updatedBody).toContain('Extra note');
    expect(updatedBody).toContain('New generated summary');
    expect(updatedBody).not.toContain('Old summary');
  });

  it('uses the branch diff against the parent even for the current branch', async () => {
    mockReadConfig.mockResolvedValue(makeConfig({ aiAssistantEnabled: true }));
    process.env.DUBSTACK_GEMINI_API_KEY = 'gem-key';
    mockGetCurrentBranch.mockResolvedValue('feat/a');
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
      ]),
    );
    mockGetPr.mockResolvedValue({
      number: 42,
      url: 'https://github.com/o/r/pull/42',
      title: 'feat: existing title',
      body: 'User intro',
    });
    const generateText = vi.fn().mockResolvedValue({
      text: 'Generated PR summary',
    });
    const googleModel = vi.fn().mockReturnValue('google-model');
    const createGoogleGenerativeAI = vi.fn().mockReturnValue(googleModel);
    const createGateway = vi.fn();

    await submit(
      '/repo',
      false,
      { ai: true },
      {
        generateText,
        createGoogleGenerativeAI,
        createGateway,
      },
    );

    expect(mockGetDiffBetween).toHaveBeenCalledWith('main', 'feat/a', '/repo');
    expect(mockGetDiff).not.toHaveBeenCalled();
  });

  it('surfaces diff lookup failures when ai descriptions are requested', async () => {
    mockReadConfig.mockResolvedValue(makeConfig({ aiAssistantEnabled: true }));
    process.env.DUBSTACK_GEMINI_API_KEY = 'gem-key';
    mockGetCurrentBranch.mockResolvedValue('feat/a');
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
      ]),
    );
    mockGetPr.mockResolvedValue({
      number: 42,
      url: 'https://github.com/o/r/pull/42',
      title: 'feat: existing title',
      body: 'User intro',
    });
    mockGetDiffBetween.mockRejectedValueOnce(new Error('bad refs'));

    await expect(
      submit(
        '/repo',
        false,
        { ai: true },
        {
          generateText: vi.fn(),
          createGoogleGenerativeAI: vi.fn().mockReturnValue(vi.fn()),
          createGateway: vi.fn(),
        },
      ),
    ).rejects.toThrow(
      "Failed to generate an AI PR summary for 'feat/a' because its diff could not be loaded.",
    );
  });

  it('creates new PRs with the last commit message as the title even when AI descriptions are enabled', async () => {
    mockReadConfig.mockResolvedValue(makeConfig({ aiAssistantEnabled: true }));
    process.env.DUBSTACK_GEMINI_API_KEY = 'gem-key';
    mockGetCurrentBranch.mockResolvedValue('feat/a');
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
      ]),
    );
    mockGetPr.mockResolvedValue(null);
    mockGetLastCommitMessage.mockResolvedValue('feat: exact squash title');
    mockCreatePr.mockResolvedValue({
      number: 42,
      url: 'https://github.com/o/r/pull/42',
      title: 'feat: exact squash title',
      body: '',
    });
    const generateText = vi.fn().mockResolvedValue({
      text: 'Generated PR summary',
    });
    const googleModel = vi.fn().mockReturnValue('google-model');
    const createGoogleGenerativeAI = vi.fn().mockReturnValue(googleModel);
    const createGateway = vi.fn();

    await submit(
      '/repo',
      false,
      { ai: true },
      {
        generateText,
        createGoogleGenerativeAI,
        createGateway,
      },
    );

    expect(mockCreatePr).toHaveBeenCalledWith(
      'feat/a',
      'main',
      'feat: exact squash title',
      expect.any(String),
      '/repo',
    );
  });

  it('rejects combining --ai and --no-ai', async () => {
    await expect(
      submit('/repo', false, {
        ai: true,
        noAi: true,
      }),
    ).rejects.toThrow("'--ai' cannot be combined with '--no-ai'.");
  });

  it('throws when branch is not in any stack', async () => {
    mockGetCurrentBranch.mockResolvedValue('orphan');
    mockReadState.mockResolvedValue({ stacks: [] });

    await expect(submit('/repo', false)).rejects.toThrow(
      'not part of any stack',
    );
  });

  it('throws when on a root branch', async () => {
    mockGetCurrentBranch.mockResolvedValue('main');
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
      ]),
    );

    await expect(submit('/repo', false)).rejects.toThrow(
      'Cannot submit from a root branch',
    );
    await expect(submit('/repo', false)).rejects.toMatchObject({
      recovery: expect.arrayContaining([expect.stringContaining('dub up')]),
    });
  });

  it('submits a tree stack with multiple sibling children deterministically by branch name', async () => {
    mockGetCurrentBranch.mockResolvedValue('feat/a');
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
        { name: 'feat/b', parent: 'main' },
      ]),
    );

    const result = await submit('/repo', true, { stack: true });
    expect(result.pushed).toEqual(['feat/a', 'feat/b']);
    expect(result.scope).toEqual({ kind: 'stack' });
  });

  it('defaults to current path and submits only the current linear path', async () => {
    mockGetCurrentBranch.mockResolvedValue('feat/a');
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
        { name: 'feat/b', parent: 'main' },
      ]),
    );

    const result = await submit('/repo', true);
    expect(result.pushed).toEqual(['feat/a']);
  });

  it('treats --fix as a deprecated no-op alias', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    mockGetCurrentBranch.mockResolvedValue('feat/a');
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
        { name: 'feat/b', parent: 'main' },
      ]),
    );

    const result = await submit('/repo', true, { stack: true, fix: true });
    expect(result.pushed).toEqual(['feat/a', 'feat/b']);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("'--fix' is deprecated"),
    );
    logSpy.mockRestore();
  });

  it('dry-run does not call push or gh commands', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    mockGetCurrentBranch.mockResolvedValue('feat/a');
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
      ]),
    );

    const result = await submit('/repo', true);

    expect(result.pushed).toEqual(['feat/a']);
    expect(mockPushBranch).not.toHaveBeenCalled();
    expect(mockCreatePr).not.toHaveBeenCalled();
    expect(mockUpdatePrBody).not.toHaveBeenCalled();
    expect(mockWriteState).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Submitting 1 branch'),
    );
    logSpy.mockRestore();
  });

  it('creates new PRs for branches without existing PRs', async () => {
    mockGetCurrentBranch.mockResolvedValue('feat/a');
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
      ]),
    );
    mockGetPr.mockResolvedValue(null);
    mockGetLastCommitMessage.mockResolvedValue('feat: new feature');
    mockCreatePr.mockResolvedValue({
      number: 42,
      url: 'https://github.com/o/r/pull/42',
      title: 'feat: new feature',
      body: '',
    });

    const result = await submit('/repo', false);

    expect(result.created).toEqual(['feat/a']);
    expect(mockPushBranch).toHaveBeenCalledWith('feat/a', '/repo');
    expect(mockWriteState).toHaveBeenCalled();
  });

  it('updates existing PRs instead of creating', async () => {
    mockGetCurrentBranch.mockResolvedValue('feat/a');
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
      ]),
    );
    mockGetPr.mockResolvedValue({
      number: 42,
      url: 'https://github.com/o/r/pull/42',
      title: 'feat: existing',
      body: 'old body',
    });

    const result = await submit('/repo', false);

    expect(result.updated).toEqual(['feat/a']);
    expect(result.created).toEqual([]);
    expect(mockCreatePr).not.toHaveBeenCalled();
    expect(mockUpdatePrBody).toHaveBeenCalled();
    expect(mockGetLastCommitMessage).not.toHaveBeenCalled();
  });

  it('saves pr_number and pr_link to state', async () => {
    const state = makeState([
      { name: 'main', parent: null, type: 'root' },
      { name: 'feat/a', parent: 'main' },
    ]);
    mockGetCurrentBranch.mockResolvedValue('feat/a');
    mockReadState.mockResolvedValue(state);
    mockGetPr.mockResolvedValue(null);
    mockGetLastCommitMessage.mockResolvedValue('feat: thing');
    mockCreatePr.mockResolvedValue({
      number: 99,
      url: 'https://github.com/o/r/pull/99',
      title: 'feat: thing',
      body: '',
    });

    await submit('/repo', false);

    const savedState = mockWriteState.mock.calls[0][0] as DubState;
    const featBranch = savedState.stacks[0].branches.find(
      (b) => b.name === 'feat/a',
    );
    expect(featBranch?.pr_number).toBe(99);
    expect(featBranch?.pr_link).toBe('https://github.com/o/r/pull/99');
    expect(featBranch?.last_submitted_version).toMatchObject({
      head_sha: 'feat/a-sha',
      base_sha: 'main-sha',
      base_branch: 'main',
      source: 'submit',
    });
    expect(featBranch?.last_reconciled_version).toEqual({
      head_sha: 'feat/a-sha',
      base_sha: 'main-sha',
      base_branch: 'main',
      source: 'submit',
    });
    expect(featBranch?.sync_source).toBe('submit');
    expect(featBranch?.last_synced_at).toBeTruthy();
  });

  it('sets parent_revision to base SHA on submit when not already set', async () => {
    const state = makeState([
      { name: 'main', parent: null, type: 'root' },
      { name: 'feat/a', parent: 'main' },
    ]);
    mockGetCurrentBranch.mockResolvedValue('feat/a');
    mockReadState.mockResolvedValue(state);
    mockGetPr.mockResolvedValue({
      number: 10,
      url: 'https://github.com/o/r/pull/10',
      title: 'feat: thing',
      body: '',
    });

    await submit('/repo', false);

    const savedState = mockWriteState.mock.calls[0][0] as DubState;
    const featBranch = savedState.stacks[0].branches.find(
      (b) => b.name === 'feat/a',
    );
    expect(featBranch?.parent_revision).toBe('main-sha');
  });

  it('preserves existing parent_revision on submit', async () => {
    const state = makeState([
      { name: 'main', parent: null, type: 'root' },
      {
        name: 'feat/a',
        parent: 'main',
        parent_revision: 'original-fork-sha',
      },
    ]);
    mockGetCurrentBranch.mockResolvedValue('feat/a');
    mockReadState.mockResolvedValue(state);
    mockGetPr.mockResolvedValue({
      number: 10,
      url: 'https://github.com/o/r/pull/10',
      title: 'feat: thing',
      body: '',
    });

    await submit('/repo', false);

    const savedState = mockWriteState.mock.calls[0][0] as DubState;
    const featBranch = savedState.stacks[0].branches.find(
      (b) => b.name === 'feat/a',
    );
    expect(featBranch?.parent_revision).toBe('original-fork-sha');
  });

  it('--upstack submits the current branch plus all descendants in BFS order', async () => {
    mockGetCurrentBranch.mockResolvedValue('feat/a');
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
        { name: 'feat/a-bravo', parent: 'feat/a' },
        { name: 'feat/a-alpha', parent: 'feat/a' },
        { name: 'feat/a-alpha-deep', parent: 'feat/a-alpha' },
        { name: 'feat/other', parent: 'main' },
      ]),
    );

    const result = await submit('/repo', true, { upstack: true });

    expect(result.pushed).toEqual([
      'feat/a',
      'feat/a-alpha',
      'feat/a-bravo',
      'feat/a-alpha-deep',
    ]);
    expect(result.scope).toEqual({ kind: 'upstack' });
  });

  it('--branch <name> submits only the named branch even when not currently checked out', async () => {
    mockGetCurrentBranch.mockResolvedValue('main');
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
        { name: 'feat/b', parent: 'feat/a' },
      ]),
    );

    const result = await submit('/repo', true, { branch: 'feat/b' });

    expect(result.pushed).toEqual(['feat/b']);
    expect(result.scope).toEqual({ kind: 'branch', branch: 'feat/b' });
  });

  it('--branch <name> rejects untracked branches', async () => {
    mockGetCurrentBranch.mockResolvedValue('main');
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
      ]),
    );

    await expect(
      submit('/repo', true, { branch: 'feat/nonexistent' }),
    ).rejects.toThrow('not part of any tracked stack');
  });

  it('--branch <name> rejects a root branch with an actionable error', async () => {
    mockGetCurrentBranch.mockResolvedValue('feat/a');
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
      ]),
    );

    await expect(submit('/repo', true, { branch: 'main' })).rejects.toThrow(
      "Cannot submit root branch 'main'",
    );
  });

  it("'--path current' still works in v1 and emits the deprecation warning", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockGetCurrentBranch.mockResolvedValue('feat/a');
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
      ]),
    );

    const result = await submit('/repo', true, { path: 'current' });

    expect(result.pushed).toEqual(['feat/a']);
    expect(result.scope).toEqual({ kind: 'downstack' });
    expect(warn).toHaveBeenCalledWith(
      "⚠ '--path current' is deprecated. Use '--downstack' instead. This will stop working in v2.",
    );
    warn.mockRestore();
  });

  it("'--path stack' still works in v1 and emits the deprecation warning", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockGetCurrentBranch.mockResolvedValue('feat/a');
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
        { name: 'feat/b', parent: 'main' },
      ]),
    );

    const result = await submit('/repo', true, { path: 'stack' });

    expect(result.pushed).toEqual(['feat/a', 'feat/b']);
    expect(result.scope).toEqual({ kind: 'stack' });
    expect(warn).toHaveBeenCalledWith(
      "⚠ '--path stack' is deprecated. Use '--stack' instead. This will stop working in v2.",
    );
    warn.mockRestore();
  });
});

describe('resolveScope', () => {
  it('returns downstack for empty options (default)', () => {
    expect(resolveScope({})).toEqual({ kind: 'downstack' });
  });

  it('returns the matching scope for each explicit flag', () => {
    expect(resolveScope({ upstack: true })).toEqual({ kind: 'upstack' });
    expect(resolveScope({ downstack: true })).toEqual({ kind: 'downstack' });
    expect(resolveScope({ stack: true })).toEqual({ kind: 'stack' });
    expect(resolveScope({ branch: 'feat/x' })).toEqual({
      kind: 'branch',
      branch: 'feat/x',
    });
  });

  it('rejects multiple scope flags with an actionable error', () => {
    expect(() => resolveScope({ upstack: true, downstack: true })).toThrow(
      'Scope flags are mutually exclusive: --upstack, --downstack.',
    );
    expect(() => resolveScope({ stack: true, branch: 'feat/x' })).toThrow(
      'Scope flags are mutually exclusive: --stack, --branch.',
    );
  });

  it('includes a --path-specific recovery hint when --path is part of the mutex conflict', () => {
    try {
      resolveScope({ upstack: true, path: 'current' });
      throw new Error('expected resolveScope to throw');
    } catch (error) {
      expect(error).toMatchObject({
        message: expect.stringContaining(
          'mutually exclusive: --upstack, --path',
        ),
        recovery: expect.arrayContaining([
          expect.stringContaining("Drop '--path'"),
        ]),
      });
    }
  });

  it("warns and maps '--path current' to downstack", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(resolveScope({ path: 'current' })).toEqual({ kind: 'downstack' });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("'--path current' is deprecated"),
    );
    warn.mockRestore();
  });

  it("warns and maps '--path stack' to stack", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(resolveScope({ path: 'stack' })).toEqual({ kind: 'stack' });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("'--path stack' is deprecated"),
    );
    warn.mockRestore();
  });
});
