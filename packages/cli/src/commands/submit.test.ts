import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  validatePrReviewers: vi.fn(),
  getPr: vi.fn(),
  createPr: vi.fn(),
  addPrReviewers: vi.fn(),
  markPrReady: vi.fn(),
  updatePrBody: vi.fn(),
  isPrAutoMergeEnabled: vi.fn(),
  enablePrAutoMerge: vi.fn(),
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
  addPrReviewers,
  checkGhAuth,
  createPr,
  enablePrAutoMerge,
  ensureGhInstalled,
  getPr,
  isPrAutoMergeEnabled,
  markPrReady,
  updatePrBody,
  validatePrReviewers,
} from '../lib/github';
import { readMetadataTemplates } from '../lib/metadata-templates';
import type { DubState } from '../lib/state';
import { readState, writeState } from '../lib/state';
import { resolveScope, resolveSubmitLifecycle, submit } from './submit';

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
const mockValidatePrReviewers = validatePrReviewers as ReturnType<typeof vi.fn>;
const mockGetPr = getPr as ReturnType<typeof vi.fn>;
const mockCreatePr = createPr as ReturnType<typeof vi.fn>;
const mockAddPrReviewers = addPrReviewers as ReturnType<typeof vi.fn>;
const mockMarkPrReady = markPrReady as ReturnType<typeof vi.fn>;
const mockUpdatePrBody = updatePrBody as ReturnType<typeof vi.fn>;
const mockIsPrAutoMergeEnabled = isPrAutoMergeEnabled as ReturnType<
  typeof vi.fn
>;
const mockEnablePrAutoMerge = enablePrAutoMerge as ReturnType<typeof vi.fn>;
const mockReadState = readState as ReturnType<typeof vi.fn>;
const mockWriteState = writeState as ReturnType<typeof vi.fn>;
const mockReadConfig = readConfig as ReturnType<typeof vi.fn>;
const mockReadMetadataTemplates = readMetadataTemplates as ReturnType<
  typeof vi.fn
>;

function makeConfig(overrides?: {
  aiAssistantEnabled?: boolean;
  submitDescription?: boolean;
  reviewers?: string[];
  submitDefault?: 'auto' | 'draft' | 'publish';
}) {
  return {
    aiAssistantEnabled: overrides?.aiAssistantEnabled ?? false,
    mcpMode: 'interactive' as const,
    reviewers: overrides?.reviewers ?? [],
    submitDefault: overrides?.submitDefault ?? 'auto',
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
          anthropic: null,
          gateway: null,
          bedrock: null,
          openai: null,
          ollama: null,
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

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockEnsureGhInstalled.mockResolvedValue(undefined);
  mockCheckGhAuth.mockResolvedValue(undefined);
  mockValidatePrReviewers.mockResolvedValue(undefined);
  mockReadConfig.mockResolvedValue(makeConfig());
  mockWriteState.mockResolvedValue(undefined);
  mockPushBranch.mockResolvedValue(undefined);
  mockGetBranchTip.mockImplementation(
    async (branch: string) => `${branch}-sha`,
  );
  mockGetDiff.mockResolvedValue('diff --git a/file.ts b/file.ts');
  mockGetDiffBetween.mockResolvedValue('diff --git a/file.ts b/file.ts');
  mockGetLastCommitMessage.mockResolvedValue('feat: existing title');
  mockAddPrReviewers.mockResolvedValue(undefined);
  mockMarkPrReady.mockResolvedValue(undefined);
  mockUpdatePrBody.mockResolvedValue(undefined);
  mockIsPrAutoMergeEnabled.mockResolvedValue(false);
  mockEnablePrAutoMerge.mockResolvedValue({ method: 'squash' });
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
      { reviewers: [], draft: false },
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

  it('rejects combining --reviewers and --no-reviewers', async () => {
    await expect(
      submit('/repo', false, {
        reviewers: 'alice',
        noReviewers: true,
      }),
    ).rejects.toThrow(
      "'--reviewers' cannot be combined with '--no-reviewers'.",
    );
  });

  it('rejects --method without --merge-when-ready', async () => {
    await expect(
      submit('/repo', false, {
        method: 'rebase',
      }),
    ).rejects.toThrow("'--method' requires '--merge-when-ready'.");
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

  it('creates new PRs as drafts when --draft is passed', async () => {
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
      isDraft: true,
    });

    await submit('/repo', false, { draft: true });

    expect(mockCreatePr).toHaveBeenCalledWith(
      'feat/a',
      'main',
      'feat: new feature',
      expect.any(String),
      '/repo',
      { reviewers: [], draft: true },
    );
  });

  it('uses the configured draft submit default when lifecycle flags are omitted', async () => {
    mockReadConfig.mockResolvedValue(makeConfig({ submitDefault: 'draft' }));
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
      isDraft: true,
    });

    await submit('/repo', false);

    expect(mockCreatePr).toHaveBeenCalledWith(
      'feat/a',
      'main',
      'feat: new feature',
      expect.any(String),
      '/repo',
      { reviewers: [], draft: true },
    );
  });

  it('promotes existing draft PRs when --publish is passed', async () => {
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
      isDraft: true,
    });

    const result = await submit('/repo', false, { publish: true });

    expect(result.published).toEqual(['feat/a']);
    expect(mockCreatePr).not.toHaveBeenCalled();
    expect(mockMarkPrReady).toHaveBeenCalledWith(42, '/repo');
  });

  it('rejects --publish when a selected branch has no open PR', async () => {
    mockGetCurrentBranch.mockResolvedValue('feat/a');
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
      ]),
    );
    mockGetPr.mockResolvedValue(null);

    await expect(submit('/repo', false, { publish: true })).rejects.toThrow(
      "Cannot publish 'feat/a' because no open PR exists.",
    );
    expect(mockPushBranch).not.toHaveBeenCalled();
    expect(mockCreatePr).not.toHaveBeenCalled();
  });

  it('rejects --publish dry-run when a selected branch has no open PR', async () => {
    mockGetCurrentBranch.mockResolvedValue('feat/a');
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
      ]),
    );
    mockGetPr.mockResolvedValue(null);

    await expect(submit('/repo', true, { publish: true })).rejects.toThrow(
      "Cannot publish 'feat/a' because no open PR exists.",
    );
    expect(mockGetPr).toHaveBeenCalledWith('feat/a', '/repo');
    expect(mockPushBranch).not.toHaveBeenCalled();
    expect(mockCreatePr).not.toHaveBeenCalled();
  });

  it('previews draft PR publishing during --publish dry-run without mutating GitHub', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
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
      isDraft: true,
    });

    await submit('/repo', true, { publish: true });

    expect(logSpy).toHaveBeenCalledWith(
      '[dry-run] would publish draft PR #42: feat/a',
    );
    expect(mockPushBranch).not.toHaveBeenCalled();
    expect(mockMarkPrReady).not.toHaveBeenCalled();
    expect(mockUpdatePrBody).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('rejects combining --draft and --publish', async () => {
    await expect(
      submit('/repo', false, { draft: true, publish: true }),
    ).rejects.toThrow("'--draft' cannot be combined with '--publish'.");
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

  it('creates new PRs with explicit reviewers after validating them', async () => {
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

    await submit('/repo', false, { reviewers: 'alice,bob,@org/team' });

    expect(mockValidatePrReviewers).toHaveBeenCalledWith(
      ['alice', 'bob', '@org/team'],
      '/repo',
    );
    expect(mockCreatePr).toHaveBeenCalledWith(
      'feat/a',
      'main',
      'feat: new feature',
      expect.any(String),
      '/repo',
      { reviewers: ['alice', 'bob', '@org/team'], draft: false },
    );
  });

  it('adds explicit reviewers to existing PRs', async () => {
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

    await submit('/repo', false, { reviewers: 'alice,bob' });

    expect(mockAddPrReviewers).toHaveBeenCalledWith(
      42,
      ['alice', 'bob'],
      '/repo',
    );
  });

  it('uses repo-default reviewers across multi-branch submits', async () => {
    mockReadConfig.mockResolvedValue(makeConfig({ reviewers: ['alice'] }));
    mockGetCurrentBranch.mockResolvedValue('feat/b');
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
        { name: 'feat/b', parent: 'feat/a' },
      ]),
    );
    mockGetPr.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    mockCreatePr
      .mockResolvedValueOnce({
        number: 10,
        url: 'https://github.com/o/r/pull/10',
        title: 'feat: existing title',
        body: '',
      })
      .mockResolvedValueOnce({
        number: 11,
        url: 'https://github.com/o/r/pull/11',
        title: 'feat: existing title',
        body: '',
      });

    await submit('/repo', false);

    expect(mockValidatePrReviewers).toHaveBeenCalledWith(['alice'], '/repo');
    expect(mockCreatePr).toHaveBeenNthCalledWith(
      1,
      'feat/a',
      'main',
      'feat: existing title',
      expect.any(String),
      '/repo',
      { reviewers: ['alice'], draft: false },
    );
    expect(mockCreatePr).toHaveBeenNthCalledWith(
      2,
      'feat/b',
      'feat/a',
      'feat: existing title',
      expect.any(String),
      '/repo',
      { reviewers: ['alice'], draft: false },
    );
  });

  it('allows --no-reviewers to skip repo-default reviewers', async () => {
    mockReadConfig.mockResolvedValue(makeConfig({ reviewers: ['alice'] }));
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

    await submit('/repo', false, { noReviewers: true });

    expect(mockValidatePrReviewers).not.toHaveBeenCalled();
    expect(mockAddPrReviewers).not.toHaveBeenCalled();
  });

  it('re-validates repo-default reviewer config before submitting', async () => {
    mockReadConfig.mockResolvedValue(
      makeConfig({ reviewers: ['alice', 'not a login'] }),
    );
    mockGetCurrentBranch.mockResolvedValue('feat/a');
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
      ]),
    );

    await expect(submit('/repo', false)).rejects.toThrow(
      "Invalid reviewer 'not a login'.",
    );
    expect(mockValidatePrReviewers).not.toHaveBeenCalled();
    expect(mockPushBranch).not.toHaveBeenCalled();
  });

  it('surfaces invalid reviewer validation before pushing', async () => {
    mockGetCurrentBranch.mockResolvedValue('feat/a');
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
      ]),
    );
    mockValidatePrReviewers.mockRejectedValueOnce(
      new Error("Reviewer 'ghost' is not a collaborator"),
    );

    await expect(
      submit('/repo', false, { reviewers: 'ghost' }),
    ).rejects.toThrow("Reviewer 'ghost' is not a collaborator");
    expect(mockPushBranch).not.toHaveBeenCalled();
  });

  it('enables auto-merge on every PR in the submit scope', async () => {
    mockGetCurrentBranch.mockResolvedValue('feat/b');
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
        { name: 'feat/b', parent: 'feat/a' },
      ]),
    );
    mockGetPr
      .mockResolvedValueOnce({
        number: 10,
        url: 'https://github.com/o/r/pull/10',
        title: 'feat: a',
        body: '',
      })
      .mockResolvedValueOnce({
        number: 11,
        url: 'https://github.com/o/r/pull/11',
        title: 'feat: b',
        body: '',
      });

    const result = await submit('/repo', false, {
      mergeWhenReady: true,
      method: 'rebase',
    });

    expect(mockIsPrAutoMergeEnabled).toHaveBeenCalledWith(10, '/repo');
    expect(mockIsPrAutoMergeEnabled).toHaveBeenCalledWith(11, '/repo');
    expect(mockEnablePrAutoMerge).toHaveBeenNthCalledWith(1, 10, '/repo', {
      method: 'rebase',
    });
    expect(mockEnablePrAutoMerge).toHaveBeenNthCalledWith(2, 11, '/repo', {
      method: 'rebase',
    });
    expect(result.autoMergeEnabled).toEqual(['feat/a', 'feat/b']);
  });

  it('does not re-enable auto-merge when GitHub already has it queued', async () => {
    mockGetCurrentBranch.mockResolvedValue('feat/a');
    mockReadState.mockResolvedValue(
      makeState([
        { name: 'main', parent: null, type: 'root' },
        { name: 'feat/a', parent: 'main' },
      ]),
    );
    mockGetPr.mockResolvedValue({
      number: 10,
      url: 'https://github.com/o/r/pull/10',
      title: 'feat: a',
      body: '',
    });
    mockIsPrAutoMergeEnabled.mockResolvedValue(true);

    const result = await submit('/repo', false, { mergeWhenReady: true });

    expect(mockEnablePrAutoMerge).not.toHaveBeenCalled();
    expect(result.autoMergeEnabled).toEqual([]);
    expect(result.autoMergeSkipped).toEqual(['feat/a']);
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

describe('resolveSubmitLifecycle', () => {
  it('uses auto mode to create drafts when GitHub workflows are configured', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dub-submit-lifecycle-'));
    try {
      await mkdir(path.join(dir, '.github', 'workflows'), {
        recursive: true,
      });
      await writeFile(
        path.join(dir, '.github', 'workflows', 'ci.yml'),
        'name: ci\n',
      );

      await expect(resolveSubmitLifecycle(dir, {}, 'auto')).resolves.toBe(
        'draft',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('uses auto mode to create ready PRs when no workflows are configured', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dub-submit-lifecycle-'));
    try {
      await expect(resolveSubmitLifecycle(dir, {}, 'auto')).resolves.toBe(
        'ready',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
