import { createScorer, evalite } from 'evalite';
import {
  type SplitProposalOutput,
  scoreSplitProposal,
} from '../src/lib/ai-eval-scorers';
import { createFaithfulnessJudgeScorer, readFixture } from './eval-support';

interface SplitAiInput {
  name: string;
  branch: string;
  parentBranch: string;
  knownFiles: string[];
  diff: string;
}

interface SplitAiExpected {
  summary: string;
  knownFiles: string[];
  minSplits?: number;
}

const CASES =
  readFixture<
    Array<{
      input: SplitAiInput;
      output: SplitProposalOutput;
      expected: SplitAiExpected;
    }>
  >('dub-split-ai.json');

evalite('dub split AI proposal coherence', {
  data: CASES,
  task: async (input): Promise<SplitProposalOutput> => {
    const fixture = CASES.find(
      (testCase) => testCase.input.name === input.name,
    );
    if (!fixture) throw new Error(`Missing fixture output for ${input.name}`);
    return fixture.output;
  },
  scorers: [
    createScorer<SplitAiInput, SplitProposalOutput, SplitAiExpected>({
      name: 'split-proposal-contract',
      description:
        'Fixture-only until live split AI lands: every changed file is assigned once to a coherent branch.',
      scorer: ({ output, expected }) => scoreSplitProposal(output, expected),
    }),
    createFaithfulnessJudgeScorer<
      SplitAiInput,
      SplitProposalOutput,
      SplitAiExpected
    >({
      name: 'split-proposal-ai-judge',
      inputToText: (input) =>
        [
          `Branch: ${input.branch}`,
          `Parent: ${input.parentBranch}`,
          `Known files: ${input.knownFiles.join(', ')}`,
          input.diff,
        ].join('\n'),
      outputToText: (output) => JSON.stringify(output, null, 2),
    }),
  ],
  columns: ({ input, output }) => [
    { label: 'Case', value: input.name },
    { label: 'Splits', value: String(output.splits.length) },
  ],
});
