import { createScorer, evalite } from 'evalite';
import { buildAiDiffContext } from '../src/lib/ai-diff-context';
import {
  type BranchNamingOutput,
  scoreBranchNaming,
} from '../src/lib/ai-eval-scorers';
import { generateCreateMetadata } from '../src/lib/ai-metadata';
import {
  createEvalDependencies,
  createFaithfulnessJudgeScorer,
  createProviderConfig,
  readFixture,
} from './eval-support';

interface CreateNamingInput {
  name: string;
  parentBranch: string;
  stagedDiff: string;
}

interface CreateNamingExpected {
  summary: string;
  prefix: string;
  requiredScopeTerms: string[];
}

const CASES = readFixture<
  Array<{
    input: CreateNamingInput;
    expected: CreateNamingExpected;
  }>
>('dub-create-naming.json');

evalite('dub create AI branch naming', {
  data: CASES,
  task: async (input): Promise<BranchNamingOutput> => {
    const generated = await generateCreateMetadata(
      buildAiDiffContext({ rawDiff: input.stagedDiff }),
      createEvalDependencies(),
      {},
      createProviderConfig(),
    );
    return { branch: generated.branch };
  },
  scorers: [
    createScorer<CreateNamingInput, BranchNamingOutput, CreateNamingExpected>({
      name: 'branch-naming-contract',
      description:
        'Branch names use the expected conventional prefix and recognizable scope terms.',
      scorer: ({ output, expected }) => scoreBranchNaming(output, expected),
    }),
    createFaithfulnessJudgeScorer<
      CreateNamingInput,
      BranchNamingOutput,
      CreateNamingExpected
    >({
      name: 'branch-naming-ai-judge',
      inputToText: (input) => input.stagedDiff,
      outputToText: (output) => output.branch,
    }),
  ],
  columns: ({ input, output }) => [
    { label: 'Case', value: input.name },
    { label: 'Branch', value: output.branch },
  ],
});
