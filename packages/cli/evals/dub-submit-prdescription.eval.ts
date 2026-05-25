import { createScorer, evalite } from 'evalite';
import { buildAiDiffContext } from '../src/lib/ai-diff-context';
import {
  type PrDescriptionOutput,
  scorePrDescription,
} from '../src/lib/ai-eval-scorers';
import { generatePrDescriptionSummary } from '../src/lib/ai-metadata';
import {
  createEvalDependencies,
  createFaithfulnessJudgeScorer,
  createProviderConfig,
  formatPrOutput,
  readFixture,
} from './eval-support';

interface SubmitPrDescriptionInput {
  name: string;
  branch: string;
  baseBranch: string;
  commitMessage: string;
  prTemplate?: string | null;
  diff: string;
}

interface SubmitPrDescriptionExpected {
  summary: string;
  templateHeadings?: string[];
  requiredKeywords: string[];
  forbiddenKeywords?: string[];
}

const CASES = readFixture<
  Array<{
    input: SubmitPrDescriptionInput;
    expected: SubmitPrDescriptionExpected;
  }>
>('dub-submit-prdescription.json');

evalite('dub submit AI PR description', {
  data: CASES,
  task: async (input): Promise<PrDescriptionOutput> => {
    const prDescription = await generatePrDescriptionSummary(
      {
        branch: input.branch,
        baseBranch: input.baseBranch,
        commitMessage: input.commitMessage,
        diff: buildAiDiffContext({ rawDiff: input.diff }),
      },
      createEvalDependencies(),
      { prTemplate: input.prTemplate },
      createProviderConfig(),
    );
    return { prDescription };
  },
  scorers: [
    createScorer<
      SubmitPrDescriptionInput,
      PrDescriptionOutput,
      SubmitPrDescriptionExpected
    >({
      name: 'pr-description-contract',
      description:
        'PR descriptions preserve templates, cover the diff, and avoid unrelated claims.',
      scorer: ({ output, expected }) => scorePrDescription(output, expected),
    }),
    createFaithfulnessJudgeScorer<
      SubmitPrDescriptionInput,
      PrDescriptionOutput,
      SubmitPrDescriptionExpected
    >({
      name: 'pr-description-ai-judge',
      inputToText: (input) =>
        [
          `Branch: ${input.branch}`,
          `Base: ${input.baseBranch}`,
          `Commit: ${input.commitMessage}`,
          `Template: ${input.prTemplate ?? '[none]'}`,
          input.diff,
        ].join('\n'),
      outputToText: formatPrOutput,
    }),
  ],
  columns: ({ input, output }) => [
    { label: 'Case', value: input.name },
    {
      label: 'Summary',
      value: output.prDescription.split('\n')[0] ?? '',
    },
  ],
});
