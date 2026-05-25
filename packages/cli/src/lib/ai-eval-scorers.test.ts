import { describe, expect, it } from 'vitest';
import {
  scoreAbsorbTargets,
  scoreBranchNaming,
  scoreConflictResolution,
  scoreEvalJudgeResponse,
  scorePrDescription,
  scoreSplitProposal,
} from './ai-eval-scorers';

describe('AI eval scorers', () => {
  it('returns deterministic branch naming scores', () => {
    const args = [
      { branch: 'feat/checkout-history' },
      { prefix: 'feat/', requiredScopeTerms: ['checkout', 'history'] },
    ] as const;

    expect(scoreBranchNaming(...args)).toEqual(scoreBranchNaming(...args));
  });

  it('matches branch scope terms case-insensitively', () => {
    expect(
      scoreBranchNaming(
        { branch: 'feat/Checkout-History' },
        { prefix: 'feat/', requiredScopeTerms: ['checkout', 'history'] },
      ).metadata?.matchedScopeTerms,
    ).toEqual(['checkout', 'history']);
  });

  it('returns deterministic PR description scores', () => {
    const args = [
      {
        prDescription:
          '## Summary\nAdds AI eval fixtures.\n\n## Testing\nCovers scorer determinism.',
      },
      {
        templateHeadings: ['## Summary', '## Testing'],
        requiredKeywords: ['eval', 'fixtures'],
        forbiddenKeywords: ['billing'],
      },
    ] as const;

    expect(scorePrDescription(...args)).toEqual(scorePrDescription(...args));
  });

  it('returns deterministic conflict resolution scores', () => {
    const args = [
      {
        resolvedContent: 'export const value = upstream + replayed;',
        explanation: 'Preserves upstream and replayed intent.',
      },
      {
        preservedSnippets: ['upstream', 'replayed'],
        forbiddenSnippets: ['<<<<<<<'],
      },
    ] as const;

    expect(scoreConflictResolution(...args)).toEqual(
      scoreConflictResolution(...args),
    );
  });

  it('returns deterministic split proposal scores', () => {
    const args = [
      {
        splits: [
          {
            branch: 'feat/readiness',
            files: ['packages/cli/src/lib/ai-readiness.ts'],
            summary: 'Add readiness checks.',
          },
          {
            branch: 'test/readiness',
            files: ['packages/cli/src/lib/ai-readiness.test.ts'],
            summary: 'Cover readiness checks.',
          },
        ],
      },
      {
        knownFiles: [
          'packages/cli/src/lib/ai-readiness.ts',
          'packages/cli/src/lib/ai-readiness.test.ts',
        ],
        minSplits: 2,
      },
    ] as const;

    expect(scoreSplitProposal(...args)).toEqual(scoreSplitProposal(...args));
  });

  it('returns deterministic absorb target scores', () => {
    const args = [
      {
        assignments: [
          { wipSha: 'bbb2222', targetSha: 'aaa1111' },
          { wipSha: 'ddd4444', targetSha: null },
        ],
      },
      {
        assignments: [
          { wipSha: 'bbb2222', targetSha: 'aaa1111' },
          { wipSha: 'ddd4444', targetSha: null },
        ],
      },
    ] as const;

    expect(scoreAbsorbTargets(...args)).toEqual(scoreAbsorbTargets(...args));
  });

  it('treats duplicate absorb assignments as invalid', () => {
    expect(
      scoreAbsorbTargets(
        {
          assignments: [
            { wipSha: 'bbb2222', targetSha: 'aaa1111' },
            { wipSha: 'bbb2222', targetSha: 'aaa1111' },
          ],
        },
        {
          assignments: [{ wipSha: 'bbb2222', targetSha: 'aaa1111' }],
        },
      ),
    ).toMatchObject({
      score: 0,
      metadata: { duplicates: ['bbb2222'] },
    });
  });

  it('returns deterministic AI judge parse scores', () => {
    const text = '{"score":87,"rationale":"faithful and useful"}';

    expect(scoreEvalJudgeResponse(text)).toEqual(scoreEvalJudgeResponse(text));
  });

  it('parses the first complete AI judge JSON object', () => {
    expect(
      scoreEvalJudgeResponse(
        '{"score":92,"rationale":"handles { braces } in strings"} trailing {"score":0}',
      ),
    ).toMatchObject({
      score: 0.92,
      metadata: { rationale: 'handles { braces } in strings' },
    });
  });
});
