import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiReviewBranch } from './ai-readiness';
import { DubError } from './errors';

afterEach(() => {
  delete process.env.DUBSTACK_GEMINI_API_KEY;
});

describe('aiReviewBranch', () => {
  it('returns parsed readiness issues from the AI judge', async () => {
    process.env.DUBSTACK_GEMINI_API_KEY = 'test-key';
    const generateText = vi.fn().mockResolvedValue({
      text:
        '```json\n' +
        '[{"severity":"major","message":"PR description has TODO.","action":"Fill in the PR description."}]\n' +
        '```',
    });
    const fakeModel = { modelId: 'gemini-test' };
    const googleModel = vi.fn().mockReturnValue(fakeModel);
    const createGoogleGenerativeAI = vi.fn().mockReturnValue(googleModel);

    const result = await aiReviewBranch(
      {
        branch: 'feat/a',
        baseBranch: 'main',
        diff: 'diff --git a/a.ts b/a.ts\n+export function a() {}\n',
        commitMessages: ['feat: add thing\n\nUseful body.'],
        prDescription: 'TODO',
      },
      {
        generateText,
        createGoogleGenerativeAI,
        createGateway: vi.fn(),
      },
      {
        selected: 'gemini',
        models: { gemini: null, gateway: null, bedrock: null },
      },
    );

    expect(result).toEqual([
      {
        severity: 'major',
        message: 'PR description has TODO.',
        action: 'Fill in the PR description.',
      },
    ]);
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: fakeModel,
        prompt: expect.stringContaining('PR_DESCRIPTION_START'),
      }),
    );
  });

  it('rejects malformed AI readiness responses', async () => {
    process.env.DUBSTACK_GEMINI_API_KEY = 'test-key';
    await expect(
      aiReviewBranch(
        {
          branch: 'feat/a',
          baseBranch: 'main',
          diff: '',
          commitMessages: [],
          prDescription: null,
        },
        {
          generateText: vi.fn().mockResolvedValue({ text: '{"oops":true}' }),
          createGoogleGenerativeAI: vi.fn().mockReturnValue(vi.fn()),
          createGateway: vi.fn(),
        },
        {
          selected: 'gemini',
          models: { gemini: null, gateway: null, bedrock: null },
        },
      ),
    ).rejects.toThrow(DubError);
  });
});
