import { describe, expect, it } from 'vitest';
import { buildAiDiffContext, categorizeDiffPath } from './ai-diff-context';

describe('categorizeDiffPath', () => {
  it('classifies repository paths using runtime-first heuristics', () => {
    expect(categorizeDiffPath('packages/cli/src/commands/flow.ts')).toBe(
      'runtime',
    );
    expect(categorizeDiffPath('packages/cli/src/commands/flow.test.ts')).toBe(
      'tests',
    );
    expect(categorizeDiffPath('README.md')).toBe('docs');
    expect(categorizeDiffPath('.agents/skills/dub-flow/SKILL.md')).toBe(
      'skills',
    );
    expect(categorizeDiffPath('docs/plans/2026-03-08-plan.md')).toBe('plans');
    expect(categorizeDiffPath('evalite.config.ts')).toBe('config');
    expect(categorizeDiffPath('pnpm-lock.yaml')).toBe('generated');
  });
});

describe('buildAiDiffContext', () => {
  it('ranks runtime implementation files ahead of docs and skills in mixed diffs', () => {
    const context = buildAiDiffContext({
      rawDiff: `diff --git a/README.md b/README.md
index 1111111..2222222 100644
--- a/README.md
+++ b/README.md
@@ -1,3 +1,8 @@
+# Updated docs
diff --git a/.agents/skills/dub-flow/SKILL.md b/.agents/skills/dub-flow/SKILL.md
index 1111111..2222222 100644
--- a/.agents/skills/dub-flow/SKILL.md
+++ b/.agents/skills/dub-flow/SKILL.md
@@ -1,3 +1,8 @@
+Use dub flow --ai
diff --git a/packages/cli/src/commands/flow.ts b/packages/cli/src/commands/flow.ts
index 1111111..2222222 100644
--- a/packages/cli/src/commands/flow.ts
+++ b/packages/cli/src/commands/flow.ts
@@ -140,3 +140,12 @@ export async function flow() {}
+const important = 'runtime change';
diff --git a/packages/cli/src/commands/flow.test.ts b/packages/cli/src/commands/flow.test.ts
index 1111111..2222222 100644
--- a/packages/cli/src/commands/flow.test.ts
+++ b/packages/cli/src/commands/flow.test.ts
@@ -1,3 +1,7 @@
+it('covers the runtime change', () => {});
`,
    });

    expect(context.dominantCategory).toBe('runtime');
    expect(context.importantFiles[0]?.path).toBe(
      'packages/cli/src/commands/flow.ts',
    );
    expect(context.promptPacket).toContain(
      'Headline guidance: Runtime or product behavior changed.',
    );
  });

  it('falls back to ranked excerpts when the full diff budget is exceeded', () => {
    const context = buildAiDiffContext(
      {
        rawDiff: `diff --git a/README.md b/README.md
index 1111111..2222222 100644
--- a/README.md
+++ b/README.md
@@ -1,3 +1,8 @@
+# Updated docs
${'docs line\n'.repeat(4_000)}
diff --git a/packages/cli/src/commands/flow.ts b/packages/cli/src/commands/flow.ts
index 1111111..2222222 100644
--- a/packages/cli/src/commands/flow.ts
+++ b/packages/cli/src/commands/flow.ts
@@ -140,3 +140,12 @@ export async function flow() {}
+const important = 'runtime change';
${'runtime line\n'.repeat(2_000)}
`,
      },
      {
        fullDiffCharBudget: 1_000,
        excerptCharBudget: 25_000,
      },
    );

    expect(context.usesFullDiff).toBe(false);
    expect(context.promptPacket).toContain('RANKED_DIFF_EXCERPTS_START');
    expect(context.promptPacket).toContain('packages/cli/src/commands/flow.ts');
    expect(context.promptPacket).toContain('README.md');
    expect(
      context.promptPacket.indexOf('packages/cli/src/commands/flow.ts'),
    ).toBeLessThan(context.promptPacket.indexOf('README.md (+1 -0)'));
  });
});
