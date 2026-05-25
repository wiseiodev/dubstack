import { createScorer, evalite } from 'evalite';
import {
  type AbsorbTargetOutput,
  scoreAbsorbTargets,
} from '../src/lib/ai-eval-scorers';
import { createFaithfulnessJudgeScorer, readFixture } from './eval-support';

interface AbsorbAiInput {
  name: string;
  wipCommits: Array<{
    shortSha: string;
    subject: string;
    files: string[];
  }>;
  candidateCommits: Array<{
    shortSha: string;
    subject: string;
    files: string[];
  }>;
}

interface AbsorbAiExpected {
  summary: string;
  assignments: Array<{
    wipSha: string;
    targetSha: string | null;
  }>;
}

const CASES =
  readFixture<
    Array<{
      input: AbsorbAiInput;
      output: AbsorbTargetOutput;
      expected: AbsorbAiExpected;
    }>
  >('dub-absorb-ai.json');

evalite('dub absorb AI target matching', {
  data: CASES,
  task: async (input): Promise<AbsorbTargetOutput> => {
    const fixture = CASES.find(
      (testCase) => testCase.input.name === input.name,
    );
    if (!fixture) throw new Error(`Missing fixture output for ${input.name}`);
    return fixture.output;
  },
  scorers: [
    createScorer<AbsorbAiInput, AbsorbTargetOutput, AbsorbAiExpected>({
      name: 'absorb-target-contract',
      description:
        'Fixture-only until live absorb AI is promoted: WIP commits match the expected earlier targets.',
      scorer: ({ output, expected }) => scoreAbsorbTargets(output, expected),
    }),
    createFaithfulnessJudgeScorer<
      AbsorbAiInput,
      AbsorbTargetOutput,
      AbsorbAiExpected
    >({
      name: 'absorb-target-ai-judge',
      inputToText: (input) => JSON.stringify(input, null, 2),
      outputToText: (output) => JSON.stringify(output, null, 2),
    }),
  ],
  columns: ({ input, output }) => [
    { label: 'Case', value: input.name },
    { label: 'Assignments', value: String(output.assignments.length) },
  ],
});
