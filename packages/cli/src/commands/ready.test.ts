import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./doctor.js', () => ({
  doctor: vi.fn(),
}));

vi.mock('./submit.js', () => ({
  getSubmitPlan: vi.fn(),
}));

vi.mock('../lib/ai-readiness.js', () => ({
  aiReviewBranch: vi.fn(),
}));

vi.mock('../lib/config.js', () => ({
  readConfig: vi.fn(),
}));

vi.mock('../lib/git.js', () => ({
  getCommitMessagesBetween: vi.fn(),
  getDiffBetween: vi.fn(),
}));

vi.mock('../lib/github.js', () => ({
  getPr: vi.fn(),
}));

import { aiReviewBranch } from '../lib/ai-readiness';
import { readConfig } from '../lib/config';
import { getCommitMessagesBetween, getDiffBetween } from '../lib/git';
import { getPr } from '../lib/github';
import { doctor } from './doctor';
import { ready } from './ready';
import { getSubmitPlan } from './submit';

const mockDoctor = doctor as ReturnType<typeof vi.fn>;
const mockGetSubmitPlan = getSubmitPlan as ReturnType<typeof vi.fn>;
const mockAiReviewBranch = aiReviewBranch as ReturnType<typeof vi.fn>;
const mockReadConfig = readConfig as ReturnType<typeof vi.fn>;
const mockGetDiffBetween = getDiffBetween as ReturnType<typeof vi.fn>;
const mockGetCommitMessagesBetween = getCommitMessagesBetween as ReturnType<
  typeof vi.fn
>;
const mockGetPr = getPr as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockReadConfig.mockResolvedValue(makeConfig());
  mockGetDiffBetween.mockResolvedValue('');
  mockGetCommitMessagesBetween.mockResolvedValue(['feat: add readiness gate']);
  mockGetPr.mockResolvedValue(null);
  mockAiReviewBranch.mockResolvedValue([]);
});

describe('ready', () => {
  it('is ready when doctor is clean and submit preflight succeeds', async () => {
    mockDoctor.mockResolvedValue({
      healthy: true,
      issues: [],
      checkedBranch: 'feat/a',
    });
    mockGetSubmitPlan.mockResolvedValue({
      currentBranch: 'feat/a',
      rootBranch: 'main',
      scope: { kind: 'downstack' },
      branches: [
        { name: 'feat/a', parent: 'main', pr_number: null, pr_link: null },
      ],
    });

    const result = await ready('/repo');
    expect(result.ready).toBe(true);
    expect(result.scope).toBe('downstack');
    expect(result.submitBranches).toEqual(['feat/a']);
    expect(result.blockers).toEqual([]);
    expect(result.aiReview).toBeNull();
  });

  it('is not ready when doctor reports issues', async () => {
    mockDoctor.mockResolvedValue({
      healthy: false,
      issues: [
        {
          code: 'operation-in-progress',
          summary: 'restack in progress',
          details: 'run continue/abort',
          fixes: ['dub continue', 'dub abort'],
        },
      ],
      checkedBranch: 'feat/a',
    });
    mockGetSubmitPlan.mockResolvedValue({
      currentBranch: 'feat/a',
      rootBranch: 'main',
      scope: { kind: 'downstack' },
      branches: [
        { name: 'feat/a', parent: 'main', pr_number: null, pr_link: null },
      ],
    });

    const result = await ready('/repo');
    expect(result.ready).toBe(false);
    expect(result.blockers).toContain('operation-in-progress');
  });

  it('is not ready when submit preflight fails', async () => {
    mockDoctor.mockResolvedValue({
      healthy: true,
      issues: [],
      checkedBranch: 'feat/a',
    });
    mockGetSubmitPlan.mockRejectedValue(
      new Error('Cannot submit from a root branch'),
    );

    const result = await ready('/repo');
    expect(result.ready).toBe(false);
    expect(result.blockers).toContain('submit-preflight');
  });

  it('downstack scope returns the current branch plus ancestors', async () => {
    mockDoctor.mockResolvedValue({
      healthy: true,
      issues: [],
      checkedBranch: 'feat/b2',
    });
    mockGetSubmitPlan.mockResolvedValue({
      currentBranch: 'feat/b2',
      rootBranch: 'main',
      scope: { kind: 'downstack' },
      branches: [
        { name: 'feat/a', parent: 'main', pr_number: null, pr_link: null },
        { name: 'feat/b2', parent: 'feat/a', pr_number: null, pr_link: null },
      ],
    });

    const result = await ready('/repo', { scope: 'downstack' });
    expect(result.scope).toBe('downstack');
    expect(result.submitBranches).toEqual(['feat/a', 'feat/b2']);
    expect(mockGetSubmitPlan).toHaveBeenCalledWith('/repo', {
      downstack: true,
    });
  });

  it('current scope narrows to just the current branch', async () => {
    mockDoctor.mockResolvedValue({
      healthy: true,
      issues: [],
      checkedBranch: 'feat/b2',
    });
    mockGetSubmitPlan.mockResolvedValue({
      currentBranch: 'feat/b2',
      rootBranch: 'main',
      scope: { kind: 'downstack' },
      branches: [
        { name: 'feat/a', parent: 'main', pr_number: null, pr_link: null },
        { name: 'feat/b2', parent: 'feat/a', pr_number: null, pr_link: null },
      ],
    });

    const result = await ready('/repo', { scope: 'current' });
    expect(result.scope).toBe('current');
    expect(result.submitBranches).toEqual(['feat/b2']);
    expect(mockGetSubmitPlan).toHaveBeenCalledWith('/repo', {
      downstack: true,
    });
  });

  it('stack scope checks every branch in the stack', async () => {
    mockDoctor.mockResolvedValue({
      healthy: true,
      issues: [],
      checkedBranch: 'feat/b2',
    });
    mockGetSubmitPlan.mockResolvedValue({
      currentBranch: 'feat/b2',
      rootBranch: 'main',
      scope: { kind: 'stack' },
      branches: [
        { name: 'feat/a', parent: 'main', pr_number: null, pr_link: null },
        { name: 'feat/b1', parent: 'feat/a', pr_number: null, pr_link: null },
        { name: 'feat/b2', parent: 'feat/a', pr_number: null, pr_link: null },
        { name: 'feat/b3', parent: 'feat/a', pr_number: null, pr_link: null },
      ],
    });

    const result = await ready('/repo', { scope: 'stack' });
    expect(result.scope).toBe('stack');
    expect(result.submitBranches).toEqual([
      'feat/a',
      'feat/b1',
      'feat/b2',
      'feat/b3',
    ]);
    expect(mockGetSubmitPlan).toHaveBeenCalledWith('/repo', { stack: true });
  });

  it('runs AI readiness checks for the selected branch scope', async () => {
    mockDoctor.mockResolvedValue({
      healthy: true,
      issues: [],
      checkedBranch: 'feat/a',
    });
    mockGetSubmitPlan.mockResolvedValue({
      currentBranch: 'feat/a',
      rootBranch: 'main',
      scope: { kind: 'downstack' },
      branches: [
        { name: 'feat/a', parent: 'main', pr_number: null, pr_link: null },
      ],
    });
    mockGetDiffBetween.mockResolvedValue(
      'diff --git a/src/a.ts b/src/a.ts\n+export function a() {}\n',
    );
    mockGetCommitMessagesBetween.mockResolvedValue([
      'feat: add readiness gate\n\nAdds a pre-submit review.',
    ]);

    const result = await ready('/repo', { ai: true });

    expect(result.ready).toBe(true);
    expect(result.aiReview).toEqual({
      skipped: false,
      branches: [{ branch: 'feat/a', baseBranch: 'main', issues: [] }],
    });
    expect(mockAiReviewBranch).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: 'feat/a',
        baseBranch: 'main',
        commitMessages: [
          'feat: add readiness gate\n\nAdds a pre-submit review.',
        ],
      }),
      expect.any(Object),
      expect.any(Object),
    );
  });

  it('surfaces a major issue when the PR description contains a TODO', async () => {
    mockDoctor.mockResolvedValue({
      healthy: true,
      issues: [],
      checkedBranch: 'feat/a',
    });
    mockGetSubmitPlan.mockResolvedValue({
      currentBranch: 'feat/a',
      rootBranch: 'main',
      scope: { kind: 'downstack' },
      branches: [
        { name: 'feat/a', parent: 'main', pr_number: null, pr_link: null },
      ],
    });
    mockGetPr.mockResolvedValue({ body: '## Summary\nTODO: fill this in' });
    mockAiReviewBranch.mockImplementation(async (input) => {
      return input.prDescription?.includes('TODO')
        ? [
            {
              severity: 'major',
              message: 'PR description still contains a TODO marker.',
              action: 'Replace the placeholder with a real summary.',
            },
          ]
        : [];
    });

    const result = await ready('/repo', { ai: true });

    expect(result.ready).toBe(true);
    expect(result.aiReview?.branches[0]?.issues).toEqual([
      {
        severity: 'major',
        message: 'PR description still contains a TODO marker.',
        action: 'Replace the placeholder with a real summary.',
      },
    ]);
  });

  it('surfaces a minor issue for a touched function without test changes', async () => {
    mockDoctor.mockResolvedValue({
      healthy: true,
      issues: [],
      checkedBranch: 'feat/a',
    });
    mockGetSubmitPlan.mockResolvedValue({
      currentBranch: 'feat/a',
      rootBranch: 'main',
      scope: { kind: 'downstack' },
      branches: [
        { name: 'feat/a', parent: 'main', pr_number: null, pr_link: null },
      ],
    });
    mockGetDiffBetween.mockResolvedValue(
      'diff --git a/packages/cli/src/lib/a.ts b/packages/cli/src/lib/a.ts\n+export function a() {}\n',
    );
    mockAiReviewBranch.mockImplementation(async (input) => {
      return input.diff.includes('function') && !input.diff.includes('.test.ts')
        ? [
            {
              severity: 'minor',
              message: 'Runtime function changed without nearby test changes.',
              action:
                'Add focused tests or document why existing coverage applies.',
            },
          ]
        : [];
    });

    const result = await ready('/repo', { ai: true });

    expect(result.ready).toBe(true);
    expect(result.aiReview?.branches[0]?.issues[0]).toMatchObject({
      severity: 'minor',
      message: 'Runtime function changed without nearby test changes.',
    });
  });

  it('blocks on critical AI readiness issues', async () => {
    mockDoctor.mockResolvedValue({
      healthy: true,
      issues: [],
      checkedBranch: 'feat/a',
    });
    mockGetSubmitPlan.mockResolvedValue({
      currentBranch: 'feat/a',
      rootBranch: 'main',
      scope: { kind: 'downstack' },
      branches: [
        { name: 'feat/a', parent: 'main', pr_number: null, pr_link: null },
      ],
    });
    mockAiReviewBranch.mockResolvedValue([
      {
        severity: 'critical',
        message: 'Commit subject is not conventional.',
        action: 'Amend the commit subject before submitting.',
      },
    ]);

    const result = await ready('/repo', { ai: true });

    expect(result.ready).toBe(false);
    expect(result.blockers).toContain('ai-review');
  });

  it('throws clearly when AI review is requested while AI is disabled', async () => {
    mockDoctor.mockResolvedValue({
      healthy: true,
      issues: [],
      checkedBranch: 'feat/a',
    });
    mockGetSubmitPlan.mockResolvedValue({
      currentBranch: 'feat/a',
      rootBranch: 'main',
      scope: { kind: 'downstack' },
      branches: [
        { name: 'feat/a', parent: 'main', pr_number: null, pr_link: null },
      ],
    });
    mockReadConfig.mockResolvedValue({
      ...makeConfig(),
      aiAssistantEnabled: false,
    });

    await expect(ready('/repo', { ai: true })).rejects.toThrow(
      'AI assistant is disabled',
    );
    expect(mockAiReviewBranch).not.toHaveBeenCalled();
  });

  it('lets --ai-skip-review bypass critical AI readiness issues', async () => {
    mockDoctor.mockResolvedValue({
      healthy: true,
      issues: [],
      checkedBranch: 'feat/a',
    });
    mockGetSubmitPlan.mockResolvedValue({
      currentBranch: 'feat/a',
      rootBranch: 'main',
      scope: { kind: 'downstack' },
      branches: [
        { name: 'feat/a', parent: 'main', pr_number: null, pr_link: null },
      ],
    });
    mockAiReviewBranch.mockResolvedValue([
      {
        severity: 'critical',
        message: 'Commit subject is not conventional.',
        action: 'Amend the commit subject before submitting.',
      },
    ]);

    const result = await ready('/repo', {
      ai: true,
      aiSkipReview: true,
    });

    expect(result.ready).toBe(true);
    expect(result.blockers).not.toContain('ai-review');
    expect(result.aiReview?.skipped).toBe(true);
  });

  it('aggregates AI readiness results for stack scope', async () => {
    mockDoctor.mockResolvedValue({
      healthy: true,
      issues: [],
      checkedBranch: 'feat/b2',
    });
    mockGetSubmitPlan.mockResolvedValue({
      currentBranch: 'feat/b2',
      rootBranch: 'main',
      scope: { kind: 'stack' },
      branches: [
        { name: 'feat/a', parent: 'main', pr_number: null, pr_link: null },
        { name: 'feat/b1', parent: 'feat/a', pr_number: null, pr_link: null },
        { name: 'feat/b2', parent: 'feat/a', pr_number: null, pr_link: null },
      ],
    });
    mockAiReviewBranch.mockImplementation(async (input) => [
      {
        severity: 'minor',
        message: `${input.branch} has a heuristic test coverage gap.`,
        action: 'Review coverage before submit.',
      },
    ]);

    const result = await ready('/repo', { ai: true, scope: 'stack' });

    expect(result.ready).toBe(true);
    expect(result.aiReview?.branches.map((branch) => branch.branch)).toEqual([
      'feat/a',
      'feat/b1',
      'feat/b2',
    ]);
    expect(mockAiReviewBranch).toHaveBeenCalledTimes(3);
  });
});

function makeConfig() {
  return {
    aiAssistantEnabled: true,
    ai: {
      provider: {
        selected: 'auto',
        models: {
          gemini: null,
          gateway: null,
          bedrock: null,
        },
      },
    },
  };
}
