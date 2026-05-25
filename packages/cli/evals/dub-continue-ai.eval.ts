import { createScorer, evalite } from 'evalite';
import {
  type ConflictResolutionOutput,
  scoreConflictResolution,
} from '../src/lib/ai-eval-scorers';
import { createFaithfulnessJudgeScorer, readFixture } from './eval-support';

interface ContinueAiInput {
  name: string;
  path: string;
  conflict: string;
}

interface ContinueAiExpected {
  summary: string;
  preservedSnippets: string[];
  forbiddenSnippets?: string[];
}

const CASES = readFixture<
  Array<{
    input: ContinueAiInput;
    output: ConflictResolutionOutput;
    expected: ContinueAiExpected;
  }>
>('dub-continue-ai.json');

evalite('dub continue AI conflict resolution', {
  data: CASES,
  task: async (input): Promise<ConflictResolutionOutput> => {
    const fixture = CASES.find(
      (testCase) => testCase.input.name === input.name,
    );
    if (!fixture) throw new Error(`Missing fixture output for ${input.name}`);
    return fixture.output;
  },
  scorers: [
    createScorer<ContinueAiInput, ConflictResolutionOutput, ContinueAiExpected>(
      {
        name: 'conflict-resolution-contract',
        description:
          'Conflict resolutions preserve both sides where intended and remove conflict markers.',
        scorer: ({ output, expected }) =>
          scoreConflictResolution(output, expected),
      },
    ),
    createFaithfulnessJudgeScorer<
      ContinueAiInput,
      ConflictResolutionOutput,
      ContinueAiExpected
    >({
      name: 'conflict-resolution-ai-judge',
      inputToText: (input) => `${input.path}\n${input.conflict}`,
      outputToText: (output) =>
        `${output.resolvedContent}\n\n${output.explanation}`,
    }),
  ],
  columns: ({ input, output }) => [
    { label: 'Case', value: input.name },
    { label: 'Path', value: input.path },
    { label: 'Explanation', value: output.explanation },
  ],
});
