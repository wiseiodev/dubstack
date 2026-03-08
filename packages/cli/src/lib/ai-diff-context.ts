import { redactSensitiveText } from './history';

export type AiDiffFileCategory =
  | 'runtime'
  | 'tests'
  | 'docs'
  | 'skills'
  | 'plans'
  | 'config'
  | 'generated'
  | 'other';

export interface AiDiffStatEntry {
  path: string;
  additions: number;
  deletions: number;
}

export interface AiDiffContextInput {
  rawDiff: string;
  filePaths?: string[];
  diffStats?: AiDiffStatEntry[];
}

export interface RankedAiDiffFile extends AiDiffStatEntry {
  category: AiDiffFileCategory;
  weight: number;
  diff: string;
}

export interface AiDiffContext {
  rawDiff: string;
  files: string[];
  diffStats: AiDiffStatEntry[];
  totalAdditions: number;
  totalDeletions: number;
  broadChange: boolean;
  dominantCategory: AiDiffFileCategory;
  importantFiles: RankedAiDiffFile[];
  promptPacket: string;
  usesFullDiff: boolean;
}

interface DiffSection {
  path: string;
  diff: string;
  additions: number;
  deletions: number;
}

interface BuildAiDiffContextOptions {
  fullDiffCharBudget?: number;
  excerptCharBudget?: number;
  maxImportantFiles?: number;
}

const DEFAULT_FULL_DIFF_CHAR_BUDGET = 300_000;
const DEFAULT_EXCERPT_CHAR_BUDGET = 140_000;
const DEFAULT_MAX_IMPORTANT_FILES = 16;

const CATEGORY_PRIORITY: AiDiffFileCategory[] = [
  'runtime',
  'config',
  'tests',
  'docs',
  'skills',
  'plans',
  'generated',
  'other',
];

const CATEGORY_HEADLINE_GUIDANCE: Record<AiDiffFileCategory, string> = {
  runtime:
    'Runtime or product behavior changed. Prefer this in the branch and commit headline.',
  config:
    'Configuration or tooling changed. Use this in the headline when runtime behavior is not the primary change.',
  tests:
    'Tests changed. Mention them in the PR description and use them in the headline only when they are the primary work.',
  docs: 'Docs changed. Keep them in supporting context unless the change set is documentation-led.',
  skills:
    'Agent skill content changed. Keep it supporting unless the change set is primarily skills.',
  plans:
    'Plan or design docs changed. Keep them supporting unless planning is the primary work.',
  generated:
    'Generated or lockfile changes are supporting context unless they are the main purpose of the change.',
  other:
    'Miscellaneous files changed. Use them as supporting context unless they are clearly the main work.',
};

export function buildAiDiffContext(
  input: AiDiffContextInput,
  options: BuildAiDiffContextOptions = {},
): AiDiffContext {
  const fullDiffCharBudget =
    options.fullDiffCharBudget ?? DEFAULT_FULL_DIFF_CHAR_BUDGET;
  const excerptCharBudget =
    options.excerptCharBudget ?? DEFAULT_EXCERPT_CHAR_BUDGET;
  const maxImportantFiles =
    options.maxImportantFiles ?? DEFAULT_MAX_IMPORTANT_FILES;
  const redactedRawDiff = redactSensitiveText(input.rawDiff).trim();
  const parsedSections = parseDiffSections(redactedRawDiff);
  const fallbackFiles = parsedSections.map((section) => section.path);
  const files = normalizeFilePaths(input.filePaths ?? fallbackFiles);
  const diffStats = mergeDiffStats(
    files,
    input.diffStats ?? [],
    parsedSections,
  );
  const importantFiles = buildRankedFiles(diffStats, parsedSections).slice(
    0,
    Math.max(maxImportantFiles, CATEGORY_PRIORITY.length),
  );
  const totalAdditions = diffStats.reduce(
    (sum, entry) => sum + entry.additions,
    0,
  );
  const totalDeletions = diffStats.reduce(
    (sum, entry) => sum + entry.deletions,
    0,
  );
  const representedCategories = CATEGORY_PRIORITY.filter((category) =>
    diffStats.some((entry) => categorizeDiffPath(entry.path) === category),
  );
  const broadChange = representedCategories.length >= 3;
  const dominantCategory = determineDominantCategory(importantFiles);
  const usesFullDiff = redactedRawDiff.length <= fullDiffCharBudget;
  const promptPacket = buildPromptPacket({
    rawDiff: redactedRawDiff,
    files,
    diffStats,
    importantFiles,
    totalAdditions,
    totalDeletions,
    broadChange,
    dominantCategory,
    usesFullDiff,
    excerptCharBudget,
  });

  return {
    rawDiff: redactedRawDiff,
    files,
    diffStats,
    totalAdditions,
    totalDeletions,
    broadChange,
    dominantCategory,
    importantFiles,
    promptPacket,
    usesFullDiff,
  };
}

export function categorizeDiffPath(path: string): AiDiffFileCategory {
  const normalizedPath = path.replace(/\\/g, '/');

  if (
    normalizedPath.startsWith('packages/cli/src/') ||
    normalizedPath.startsWith('apps/docs/app/') ||
    normalizedPath.startsWith('apps/docs/components/')
  ) {
    return isTestPath(normalizedPath) ? 'tests' : 'runtime';
  }

  if (isTestPath(normalizedPath)) {
    return 'tests';
  }

  if (
    normalizedPath === 'README.md' ||
    normalizedPath === 'QUICKSTART.md' ||
    normalizedPath.startsWith('apps/docs/') ||
    normalizedPath.startsWith('docs/')
  ) {
    return normalizedPath.startsWith('docs/plans/') ? 'plans' : 'docs';
  }

  if (
    normalizedPath.startsWith('skills/') ||
    normalizedPath.startsWith('.agents/skills/')
  ) {
    return 'skills';
  }

  if (
    normalizedPath === 'package.json' ||
    normalizedPath === 'pnpm-lock.yaml' ||
    normalizedPath === 'turbo.json' ||
    normalizedPath === 'tsconfig.json' ||
    normalizedPath === 'biome.json' ||
    normalizedPath === '.nvmrc' ||
    normalizedPath.endsWith('.config.ts') ||
    normalizedPath.endsWith('.config.js') ||
    normalizedPath.endsWith('.config.mjs') ||
    normalizedPath.endsWith('.config.cjs')
  ) {
    return normalizedPath === 'pnpm-lock.yaml' ? 'generated' : 'config';
  }

  if (
    normalizedPath.startsWith('dist/') ||
    normalizedPath.startsWith('coverage/') ||
    normalizedPath.endsWith('.snap')
  ) {
    return 'generated';
  }

  return 'other';
}

function isTestPath(path: string): boolean {
  return (
    path.includes('/test/') ||
    path.includes('/__tests__/') ||
    path.endsWith('.test.ts') ||
    path.endsWith('.test.tsx') ||
    path.endsWith('.spec.ts') ||
    path.endsWith('.spec.tsx')
  );
}

function parseDiffSections(rawDiff: string): DiffSection[] {
  if (rawDiff.length === 0) return [];

  return rawDiff
    .split(/(?=^diff --git )/m)
    .map((section) => section.trim())
    .filter(Boolean)
    .map((section) => {
      const header = section.split('\n', 1)[0] ?? '';
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(header);
      const path = normalizeDiffPath(match?.[2] ?? match?.[1] ?? 'unknown');
      let additions = 0;
      let deletions = 0;

      for (const line of section.split('\n')) {
        if (line.startsWith('+++') || line.startsWith('---')) continue;
        if (line.startsWith('+')) additions += 1;
        else if (line.startsWith('-')) deletions += 1;
      }

      return {
        path,
        diff: section,
        additions,
        deletions,
      };
    });
}

function normalizeDiffPath(path: string): string {
  return path.replace(/^["']|["']$/g, '').replace(/^b\//, '');
}

function normalizeFilePaths(paths: string[]): string[] {
  return Array.from(
    new Set(paths.map((path) => path.trim()).filter((path) => path.length > 0)),
  );
}

function mergeDiffStats(
  files: string[],
  providedStats: AiDiffStatEntry[],
  parsedSections: DiffSection[],
): AiDiffStatEntry[] {
  const providedByPath = new Map(
    providedStats.map((entry) => [entry.path, entry] as const),
  );
  const parsedByPath = new Map(
    parsedSections.map((section) => [section.path, section] as const),
  );

  return files.map((path) => {
    const provided = providedByPath.get(path);
    if (provided) {
      return {
        path,
        additions: provided.additions,
        deletions: provided.deletions,
      };
    }

    const parsed = parsedByPath.get(path);
    return {
      path,
      additions: parsed?.additions ?? 0,
      deletions: parsed?.deletions ?? 0,
    };
  });
}

function buildRankedFiles(
  diffStats: AiDiffStatEntry[],
  parsedSections: DiffSection[],
): RankedAiDiffFile[] {
  const diffByPath = new Map(
    parsedSections.map((section) => [section.path, section.diff] as const),
  );

  return diffStats
    .map((entry) => {
      const category = categorizeDiffPath(entry.path);
      return {
        ...entry,
        category,
        diff: diffByPath.get(entry.path) ?? '',
        weight: scoreFile(
          entry.path,
          category,
          entry.additions + entry.deletions,
        ),
      };
    })
    .sort((a, b) => b.weight - a.weight || a.path.localeCompare(b.path));
}

function determineDominantCategory(
  files: RankedAiDiffFile[],
): AiDiffFileCategory {
  const scores = new Map<AiDiffFileCategory, number>();

  for (const file of files) {
    const current = scores.get(file.category) ?? 0;
    scores.set(
      file.category,
      current + scoreCategory(file.category, file.additions + file.deletions),
    );
  }

  let bestCategory: AiDiffFileCategory = 'other';
  let bestScore = -1;

  for (const category of CATEGORY_PRIORITY) {
    const score = scores.get(category) ?? 0;
    if (score > bestScore) {
      bestCategory = category;
      bestScore = score;
    }
  }

  return bestCategory;
}

function scoreFile(
  path: string,
  category: AiDiffFileCategory,
  lineCount: number,
): number {
  let score = scoreCategory(category, lineCount);

  if (path.startsWith('packages/cli/src/commands/')) score += 240;
  else if (path.startsWith('packages/cli/src/lib/')) score += 200;
  else if (path.startsWith('packages/cli/src/')) score += 160;
  else if (path.startsWith('packages/cli/test/')) score += 120;
  else if (path.startsWith('apps/docs/content/docs/')) score += 40;

  return score;
}

function scoreCategory(
  category: AiDiffFileCategory,
  lineCount: number,
): number {
  const normalizedLineCount = Math.min(lineCount, 400);
  const base =
    category === 'runtime'
      ? 1_000
      : category === 'config'
        ? 700
        : category === 'tests'
          ? 500
          : category === 'docs'
            ? 220
            : category === 'skills'
              ? 180
              : category === 'plans'
                ? 120
                : category === 'generated'
                  ? 80
                  : 160;

  return base + normalizedLineCount;
}

function buildPromptPacket(input: {
  rawDiff: string;
  files: string[];
  diffStats: AiDiffStatEntry[];
  importantFiles: RankedAiDiffFile[];
  totalAdditions: number;
  totalDeletions: number;
  broadChange: boolean;
  dominantCategory: AiDiffFileCategory;
  usesFullDiff: boolean;
  excerptCharBudget: number;
}): string {
  const manifestLines = input.diffStats.map((entry) => {
    const category = categorizeDiffPath(entry.path);
    return `- [${category}] ${entry.path} (+${entry.additions} -${entry.deletions})`;
  });
  const importantLines = input.importantFiles.map((file) => {
    return `- [${file.category}] ${file.path} (+${file.additions} -${file.deletions}) weight=${file.weight}`;
  });
  const categorySummaries = CATEGORY_PRIORITY.map((category) => {
    const files = input.diffStats.filter(
      (entry) => categorizeDiffPath(entry.path) === category,
    );
    if (files.length === 0) return null;
    return `- ${category}: ${files.length} files (${files.map((file) => file.path).join(', ')})`;
  }).filter(Boolean);

  const diffSection = input.usesFullDiff
    ? buildFullDiffSection(input.rawDiff)
    : buildExcerptSection(input.importantFiles, input.excerptCharBudget);

  return [
    'CHANGESET_OVERVIEW_START',
    `Total files: ${input.files.length}`,
    `Total line delta: +${input.totalAdditions} -${input.totalDeletions}`,
    `Broad change: ${input.broadChange ? 'yes' : 'no'}`,
    `Dominant category: ${input.dominantCategory}`,
    `Headline guidance: ${CATEGORY_HEADLINE_GUIDANCE[input.dominantCategory]}`,
    'CATEGORY_BREAKDOWN_START',
    ...categorySummaries,
    'CATEGORY_BREAKDOWN_END',
    'IMPORTANT_FILES_START',
    ...importantLines,
    'IMPORTANT_FILES_END',
    'FULL_FILE_MANIFEST_START',
    ...manifestLines,
    'FULL_FILE_MANIFEST_END',
    diffSection,
    'CHANGESET_OVERVIEW_END',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildFullDiffSection(rawDiff: string): string {
  return [
    'FULL_REDACTED_DIFF_START',
    rawDiff.length > 0 ? rawDiff : '[No textual diff available]',
    'FULL_REDACTED_DIFF_END',
  ].join('\n');
}

function buildExcerptSection(
  importantFiles: RankedAiDiffFile[],
  excerptCharBudget: number,
): string {
  const selectedFiles = selectFilesForExcerptBudget(
    importantFiles,
    excerptCharBudget,
  );
  const lines = ['RANKED_DIFF_EXCERPTS_START'];

  for (const file of selectedFiles) {
    lines.push(`FILE_START ${file.path} [${file.category}]`);
    lines.push(truncate(file.diff || '[No textual diff available]', 20_000));
    lines.push(`FILE_END ${file.path}`);
  }

  lines.push('RANKED_DIFF_EXCERPTS_END');
  return lines.join('\n');
}

function selectFilesForExcerptBudget(
  importantFiles: RankedAiDiffFile[],
  excerptCharBudget: number,
): RankedAiDiffFile[] {
  const selected: RankedAiDiffFile[] = [];
  const seen = new Set<string>();
  let remaining = excerptCharBudget;

  for (const category of CATEGORY_PRIORITY) {
    const match = importantFiles.find((file) => file.category === category);
    if (!match || seen.has(match.path)) continue;
    const diffLength = match.diff.length;
    if (selected.length > 0 && diffLength > remaining && remaining < 2_000) {
      continue;
    }
    selected.push(match);
    seen.add(match.path);
    remaining -= Math.min(diffLength, 20_000);
  }

  for (const file of importantFiles) {
    if (seen.has(file.path)) continue;
    if (remaining < 2_000) break;
    selected.push(file);
    seen.add(file.path);
    remaining -= Math.min(file.diff.length, 20_000);
  }

  return selected;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n...[truncated]`;
}
