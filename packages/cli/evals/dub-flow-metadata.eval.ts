import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createGateway, generateText, type LanguageModel } from 'ai';
import { createScorer, evalite } from 'evalite';
import { buildAiDiffContext } from '../src/lib/ai-diff-context';
import {
  type AiMetadataDependencies,
  generateFlowMetadata,
} from '../src/lib/ai-metadata';

interface FlowEvalInput {
  name: string;
  parentBranch: string;
  stagedDiff: string;
  commitTemplate?: string | null;
  prTemplate?: string | null;
  unrelatedWorkingTreeNoise?: string;
}

interface FlowEvalExpected {
  summary: string;
  branchPrefix: string;
  requiredKeywords: string[];
  forbiddenKeywords?: string[];
  headlineKeywords?: string[];
  headlineForbiddenKeywords?: string[];
  commitTemplateHeadings?: string[];
  prTemplateHeadings?: string[];
}

interface FlowEvalOutput {
  branch: string;
  commitMessage: string;
  prDescription: string;
}

const LARGE_MIXED_MONOREPO_DIFF = `diff --git a/.agents/skills/beads/SKILL.md b/.agents/skills/beads/SKILL.md
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/.agents/skills/beads/SKILL.md
@@ -0,0 +1,40 @@
+# Beads skill
+Use bd ready --json
diff --git a/.agents/skills/dub-flow-evals/SKILL.md b/.agents/skills/dub-flow-evals/SKILL.md
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/.agents/skills/dub-flow-evals/SKILL.md
@@ -0,0 +1,40 @@
+# Flow evals skill
+Run pnpm evals
diff --git a/README.md b/README.md
index 1111111..2222222 100644
--- a/README.md
+++ b/README.md
@@ -390,3 +390,25 @@
+### dub flow
+Generates metadata from staged changes.
diff --git a/QUICKSTART.md b/QUICKSTART.md
index 1111111..2222222 100644
--- a/QUICKSTART.md
+++ b/QUICKSTART.md
@@ -160,3 +160,20 @@
+dub flow --ai -a
diff --git a/packages/cli/src/lib/ai-diff-context.ts b/packages/cli/src/lib/ai-diff-context.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/packages/cli/src/lib/ai-diff-context.ts
@@ -0,0 +1,60 @@
+export function buildAiDiffContext() {
+  return {
+    dominantCategory: 'runtime',
+    promptPacket: 'structured context',
+  };
+}
diff --git a/packages/cli/src/lib/ai-metadata.ts b/packages/cli/src/lib/ai-metadata.ts
index 3333333..4444444 100644
--- a/packages/cli/src/lib/ai-metadata.ts
+++ b/packages/cli/src/lib/ai-metadata.ts
@@ -1,8 +1,30 @@
+import { buildAiDiffContext } from './ai-diff-context';
+const prompt = [
+  'Consider the entire staged change set.',
+  'Choose the headline from the dominant implementation change.',
+];
diff --git a/packages/cli/src/commands/flow.ts b/packages/cli/src/commands/flow.ts
index 5555555..6666666 100644
--- a/packages/cli/src/commands/flow.ts
+++ b/packages/cli/src/commands/flow.ts
@@ -140,6 +140,25 @@ export async function flow(
+  const stagedFiles = await getDiffFileNames(cwd, true);
+  const stagedDiffStats = await getDiffNumStat(cwd, true);
+  const staged = buildAiDiffContext({
+    rawDiff: stagedDiff,
+    filePaths: stagedFiles,
+    diffStats: stagedDiffStats,
+  });
+  const generated = await generateFlowMetadata({ parentBranch, staged }, deps);
diff --git a/packages/cli/src/commands/flow.test.ts b/packages/cli/src/commands/flow.test.ts
index 7777777..8888888 100644
--- a/packages/cli/src/commands/flow.test.ts
+++ b/packages/cli/src/commands/flow.test.ts
@@ -1,3 +1,12 @@
+it('collects structured staged context before asking AI', () => {
+  expect(getDiffFileNames).toHaveBeenCalled();
+  expect(getDiffNumStat).toHaveBeenCalled();
+});
diff --git a/packages/cli/evals/dub-flow-metadata.eval.ts b/packages/cli/evals/dub-flow-metadata.eval.ts
index 9999999..aaaaaaa 100644
--- a/packages/cli/evals/dub-flow-metadata.eval.ts
+++ b/packages/cli/evals/dub-flow-metadata.eval.ts
@@ -1,5 +1,16 @@
+const mixedCase = 'large mixed monorepo diff';
+const rubric = 'penalize docs-first headlines when runtime changed';
`;

const FLOW_CASES: Array<{
  input: FlowEvalInput;
  expected: FlowEvalExpected;
}> = [
  {
    input: {
      name: 'simple feature diff',
      parentBranch: 'main',
      stagedDiff: `diff --git a/packages/cli/src/commands/flow.ts b/packages/cli/src/commands/flow.ts
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/packages/cli/src/commands/flow.ts
@@ -0,0 +1,22 @@
+export async function previewFlow() {
+  renderPreview('Branch Name', 'feat/preview-flow');
+  renderPreview('PR Description', 'Shows generated metadata before mutation.');
+}
diff --git a/packages/cli/src/commands/flow.test.ts b/packages/cli/src/commands/flow.test.ts
new file mode 100644
index 0000000..2222222
--- /dev/null
+++ b/packages/cli/src/commands/flow.test.ts
@@ -0,0 +1,8 @@
+it('previews generated flow metadata', () => {
+  expect(renderPreview).toHaveBeenCalled();
+});
`,
    },
    expected: {
      summary: 'Adds the new preview-first AI flow command.',
      branchPrefix: 'feat/',
      requiredKeywords: ['flow', 'preview'],
    },
  },
  {
    input: {
      name: 'bug fix diff',
      parentBranch: 'main',
      stagedDiff: `diff --git a/packages/cli/src/commands/submit.ts b/packages/cli/src/commands/submit.ts
index 1111111..2222222 100644
--- a/packages/cli/src/commands/submit.ts
+++ b/packages/cli/src/commands/submit.ts
@@ -430,7 +430,11 @@ async function getDiffForPrDescription(
-  return getDiff(cwd, false);
+  return getDiffBetween(baseBranch, branchName, cwd);
diff --git a/packages/cli/src/lib/git.ts b/packages/cli/src/lib/git.ts
index 3333333..4444444 100644
--- a/packages/cli/src/lib/git.ts
+++ b/packages/cli/src/lib/git.ts
@@ -470,6 +470,12 @@ export async function getDiffBetween(
-    return '';
+    throw new DubError(
+      \`Failed to diff '\${head}' against '\${base}'. Verify both refs exist and are reachable.\`,
+    );
`,
    },
    expected: {
      summary:
        'Fixes submit AI summaries so they use the branch diff instead of local working tree noise.',
      branchPrefix: 'fix/',
      requiredKeywords: ['diff', 'submit', 'branch'],
      forbiddenKeywords: ['working tree'],
    },
  },
  {
    input: {
      name: 'commit template case',
      parentBranch: 'main',
      commitTemplate: `feat(scope): summary

## Testing
- [ ] added coverage

## Rollout
- [ ] safe to enable`,
      stagedDiff: `diff --git a/packages/cli/src/lib/metadata-templates.ts b/packages/cli/src/lib/metadata-templates.ts
index 1111111..2222222 100644
--- a/packages/cli/src/lib/metadata-templates.ts
+++ b/packages/cli/src/lib/metadata-templates.ts
@@ -1,6 +1,18 @@
+export async function readMetadataTemplates() {
+  return {
+    commitTemplate: fs.readFileSync('.gitmessage', 'utf8'),
+    prTemplate: null,
+  };
+}
`,
    },
    expected: {
      summary:
        'Preserves the repository commit template in generated flow commits.',
      branchPrefix: 'feat/',
      requiredKeywords: ['template', 'commit'],
      commitTemplateHeadings: ['## Testing', '## Rollout'],
    },
  },
  {
    input: {
      name: 'pr template case',
      parentBranch: 'main',
      prTemplate: `## Summary

## Testing

## Risks`,
      stagedDiff: `diff --git a/packages/cli/src/commands/flow.ts b/packages/cli/src/commands/flow.ts
index 1111111..2222222 100644
--- a/packages/cli/src/commands/flow.ts
+++ b/packages/cli/src/commands/flow.ts
@@ -120,6 +120,16 @@ export async function flow(
+  renderPreview('PR Description', prDescription);
+  renderPreview('Planned Commands', plannedCommands);
+  if (options.yes) {
+    return submit(cwd, false, {
+      path: 'current',
+      fix: false,
+      summaryOverrides: new Map([[generated.branch, prDescription]]),
+    });
+  }
`,
    },
    expected: {
      summary:
        'Preserves the PR template while previewing and submitting flow content.',
      branchPrefix: 'feat/',
      requiredKeywords: ['template', 'preview', 'submit'],
      prTemplateHeadings: ['## Summary', '## Testing', '## Risks'],
    },
  },
  {
    input: {
      name: 'noisy tests and docs diff',
      parentBranch: 'main',
      stagedDiff: `diff --git a/packages/cli/src/commands/flow.ts b/packages/cli/src/commands/flow.ts
index 1111111..2222222 100644
--- a/packages/cli/src/commands/flow.ts
+++ b/packages/cli/src/commands/flow.ts
@@ -1,5 +1,14 @@
+const summaryOverrides = new Map([[generated.branch, prDescription]]);
+await submit(cwd, false, { path: 'current', fix: false, summaryOverrides });
diff --git a/packages/cli/src/commands/flow.test.ts b/packages/cli/src/commands/flow.test.ts
index 3333333..4444444 100644
--- a/packages/cli/src/commands/flow.test.ts
+++ b/packages/cli/src/commands/flow.test.ts
@@ -1,4 +1,10 @@
+it('passes summary overrides to submit', () => {
+  expect(submit).toHaveBeenCalled();
+});
diff --git a/README.md b/README.md
index 5555555..6666666 100644
--- a/README.md
+++ b/README.md
@@ -397,3 +397,8 @@
+### dub flow
+Generates branch, commit, and PR content from staged changes.
`,
    },
    expected: {
      summary:
        'Captures the main flow behavior even when the diff also includes tests and documentation updates.',
      branchPrefix: 'feat/',
      requiredKeywords: ['flow', 'submit', 'summary'],
    },
  },
  {
    input: {
      name: 'ignore unrelated local noise',
      parentBranch: 'main',
      stagedDiff: `diff --git a/packages/cli/src/lib/auth.ts b/packages/cli/src/lib/auth.ts
index 1111111..2222222 100644
--- a/packages/cli/src/lib/auth.ts
+++ b/packages/cli/src/lib/auth.ts
@@ -1,5 +1,14 @@
+export function redactToken(token: string): string {
+  return token.slice(0, 4) + '…';
+}
diff --git a/packages/cli/src/lib/auth.test.ts b/packages/cli/src/lib/auth.test.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/packages/cli/src/lib/auth.test.ts
@@ -0,0 +1,6 @@
+it('redacts api tokens in logs', () => {
+  expect(redactToken('secret-token')).toBe('secr…');
+});
`,
      unrelatedWorkingTreeNoise:
        'A separate unstaged billing CSV exporter refactor should not appear in the generated metadata.',
    },
    expected: {
      summary:
        'Focuses on auth token redaction and ignores unrelated unstaged billing work.',
      branchPrefix: 'feat/',
      requiredKeywords: ['auth', 'token'],
      forbiddenKeywords: ['billing', 'csv', 'exporter'],
    },
  },
  {
    input: {
      name: 'large mixed monorepo diff',
      parentBranch: 'main',
      stagedDiff: LARGE_MIXED_MONOREPO_DIFF,
    },
    expected: {
      summary:
        'Improves dub flow metadata quality by building structured staged context and using that to drive AI generation.',
      branchPrefix: 'feat/',
      requiredKeywords: ['flow', 'context'],
      headlineKeywords: ['flow', 'context'],
      headlineForbiddenKeywords: ['beads', 'skill', 'readme'],
    },
  },
];

evalite('dub flow metadata generation', {
  data: FLOW_CASES,
  task: async (input): Promise<FlowEvalOutput> => {
    return generateFlowMetadata(
      {
        parentBranch: input.parentBranch,
        staged: buildAiDiffContext({ rawDiff: input.stagedDiff }),
      },
      createEvalDependencies(),
      {
        commitTemplate: input.commitTemplate,
        prTemplate: input.prTemplate,
      },
    );
  },
  scorers: [
    createScorer({
      name: 'branch-contract',
      description:
        'Branch names stay lowercase, slash-delimited, and match the expected prefix.',
      scorer: ({ output, expected }) => {
        const valid =
          output.branch.startsWith(expected?.branchPrefix ?? '') &&
          /^[a-z0-9]+(?:[/-][a-z0-9]+)*$/.test(output.branch);
        return {
          score: valid ? 1 : 0,
          metadata: {
            branch: output.branch,
            expectedPrefix: expected?.branchPrefix,
          },
        };
      },
    }),
    createScorer({
      name: 'commit-contract',
      description:
        'Commit messages use a conventional subject and preserve commit template headings when present.',
      scorer: ({ output, expected }) => {
        const subject = output.commitMessage.split('\n')[0]?.trim() ?? '';
        const conventional =
          /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]+\))?!?: .+/.test(
            subject,
          );
        const headings = expected?.commitTemplateHeadings ?? [];
        const preserved = headings.every((heading) =>
          output.commitMessage.includes(heading),
        );
        const fenceFree = !output.commitMessage.includes('```');
        return {
          score: conventional && preserved && fenceFree ? 1 : 0,
          metadata: { subject, headings },
        };
      },
    }),
    createScorer({
      name: 'pr-contract',
      description:
        'PR descriptions stay readable and preserve PR template heading order when present.',
      scorer: ({ output, expected }) => {
        if (output.prDescription.trim().length === 0) {
          return { score: 0, metadata: { reason: 'empty' } };
        }
        if (output.prDescription.includes('```')) {
          return { score: 0, metadata: { reason: 'markdown-fence' } };
        }
        const headings = expected?.prTemplateHeadings ?? [];
        let cursor = 0;
        const ordered = headings.every((heading) => {
          const index = output.prDescription.indexOf(heading, cursor);
          if (index === -1) return false;
          cursor = index + heading.length;
          return true;
        });
        return {
          score: ordered ? 1 : 0,
          metadata: { headings },
        };
      },
    }),
    createScorer({
      name: 'content-focus',
      description:
        'Generated metadata emphasizes the actual diff and avoids unrelated terms.',
      scorer: ({ output, expected }) => {
        const haystack = [
          output.branch,
          output.commitMessage,
          output.prDescription,
        ]
          .join('\n')
          .toLowerCase();
        const required = expected?.requiredKeywords ?? [];
        const forbidden = expected?.forbiddenKeywords ?? [];
        const matchedRequired = required.filter((keyword) =>
          haystack.includes(keyword.toLowerCase()),
        );
        const matchedForbidden = forbidden.filter((keyword) =>
          haystack.includes(keyword.toLowerCase()),
        );
        const requiredScore =
          required.length === 0 ? 1 : matchedRequired.length / required.length;
        const forbiddenPenalty =
          forbidden.length === 0 ? 1 : matchedForbidden.length === 0 ? 1 : 0;
        return {
          score: requiredScore * forbiddenPenalty,
          metadata: {
            matchedRequired,
            matchedForbidden,
          },
        };
      },
    }),
    createScorer({
      name: 'headline-focus',
      description:
        'Branch and commit headlines reflect the dominant implementation change instead of whichever files appear first.',
      scorer: ({ output, expected }) => {
        const headline = [
          output.branch,
          output.commitMessage.split('\n')[0] ?? '',
        ]
          .join('\n')
          .toLowerCase();
        const required = expected?.headlineKeywords ?? [];
        const forbidden = expected?.headlineForbiddenKeywords ?? [];
        const matchedRequired = required.filter((keyword) =>
          headline.includes(keyword.toLowerCase()),
        );
        const matchedForbidden = forbidden.filter((keyword) =>
          headline.includes(keyword.toLowerCase()),
        );
        const requiredScore =
          required.length === 0 ? 1 : matchedRequired.length / required.length;
        const forbiddenPenalty =
          forbidden.length === 0 ? 1 : matchedForbidden.length === 0 ? 1 : 0;
        return {
          score: requiredScore * forbiddenPenalty,
          metadata: {
            matchedRequired,
            matchedForbidden,
          },
        };
      },
    }),
    createScorer({
      name: 'ai-judge',
      description:
        'Judges whether the branch, commit, and PR text are faithful to the diff, useful to reviewers, and template-compliant.',
      scorer: async ({ input, output, expected }) => {
        const model = resolveEvalJudgeModel();
        const response = await generateText({
          model,
          system:
            'You are grading git metadata quality for a CLI workflow. Return strict JSON only.',
          prompt: [
            'Evaluate the generated branch name, commit message, and PR description.',
            'Score from 0 to 100.',
            'Rubric:',
            '- Faithful to the staged diff and parent branch',
            '- Useful and concise for a reviewer',
            '- Branch and commit headline should follow the dominant implementation change when runtime code changed',
            '- Preserves commit/PR template structure when provided',
            '- Avoids unrelated work or invented claims',
            '- Penalize summaries that overfit whichever files appear first in git diff output',
            'Return JSON exactly like {"score":87,"rationale":"..."}',
            '',
            `Case: ${input.name}`,
            `Expected intent: ${expected?.summary ?? ''}`,
            '',
            'STAGED_DIFF_START',
            input.stagedDiff,
            'STAGED_DIFF_END',
            '',
            'COMMIT_TEMPLATE_START',
            input.commitTemplate?.trim() || '[none]',
            'COMMIT_TEMPLATE_END',
            '',
            'PR_TEMPLATE_START',
            input.prTemplate?.trim() || '[none]',
            'PR_TEMPLATE_END',
            '',
            'UNRELATED_NOISE_START',
            input.unrelatedWorkingTreeNoise?.trim() || '[none]',
            'UNRELATED_NOISE_END',
            '',
            'GENERATED_BRANCH_START',
            output.branch,
            'GENERATED_BRANCH_END',
            '',
            'GENERATED_COMMIT_START',
            output.commitMessage,
            'GENERATED_COMMIT_END',
            '',
            'GENERATED_PR_START',
            output.prDescription,
            'GENERATED_PR_END',
          ].join('\n'),
        });

        const parsed = parseJudgeResponse(response.text);
        return {
          score: parsed.score / 100,
          metadata: { rationale: parsed.rationale },
        };
      },
    }),
  ],
  columns: ({ input, output, scores }) => [
    { label: 'Case', value: input.name },
    { label: 'Branch', value: output.branch },
    {
      label: 'Commit',
      value: output.commitMessage.split('\n')[0] ?? '',
    },
    {
      label: 'Avg',
      value:
        scores.length === 0
          ? 'n/a'
          : Math.round(
              (scores.reduce((sum, score) => sum + (score.score ?? 0), 0) /
                scores.length) *
                100,
            ),
    },
  ],
});

function createEvalDependencies(): AiMetadataDependencies {
  return {
    generateText,
    createGoogleGenerativeAI,
    createGateway,
  };
}

function resolveEvalJudgeModel(): LanguageModel {
  const geminiApiKey = process.env.DUBSTACK_GEMINI_API_KEY?.trim();
  if (geminiApiKey) {
    const modelId =
      process.env.DUBSTACK_GEMINI_MODEL?.trim() || 'gemini-3-flash-preview';
    const google = createGoogleGenerativeAI({ apiKey: geminiApiKey });
    return google(modelId);
  }

  const gatewayApiKey = process.env.DUBSTACK_AI_GATEWAY_API_KEY?.trim();
  if (gatewayApiKey) {
    const modelId =
      process.env.DUBSTACK_AI_GATEWAY_MODEL?.trim() || 'google/gemini-3-flash';
    const gateway = createGateway({ apiKey: gatewayApiKey });
    return gateway(modelId);
  }

  throw new Error(
    'Evalite requires DUBSTACK_GEMINI_API_KEY or DUBSTACK_AI_GATEWAY_API_KEY.',
  );
}

function parseJudgeResponse(text: string): {
  score: number;
  rationale: string;
} {
  const match = text.trim().match(/\{[\s\S]*\}/);
  if (!match) {
    return {
      score: 0,
      rationale: `Judge returned non-JSON output: ${text.slice(0, 200)}`,
    };
  }

  try {
    const parsed = JSON.parse(match[0]) as {
      score?: unknown;
      rationale?: unknown;
    };
    const score =
      typeof parsed.score === 'number'
        ? Math.max(0, Math.min(100, parsed.score))
        : 0;
    const rationale =
      typeof parsed.rationale === 'string'
        ? parsed.rationale
        : 'Judge did not provide a rationale.';
    return { score, rationale };
  } catch {
    return {
      score: 0,
      rationale: `Judge returned invalid JSON: ${text.slice(0, 200)}`,
    };
  }
}
