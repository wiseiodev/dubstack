import type { AiDiffContext } from './ai-diff-context';
import type { AiMetadataDependencies } from './ai-metadata';
import { resolveAiProvider } from './ai-provider';
import type { DubConfig } from './config';
import { DubError } from './errors';

/** A single proposed split branch returned by the AI mode. */
export interface AiSplitProposal {
  /** Suggested branch name (kebab-case, no leading slash). */
  branch: string;
  /** Files this proposed branch should contain. */
  files: string[];
  /** One-line summary describing the chunk. */
  summary: string;
}

/**
 * Asks the configured AI provider to propose a semantic split of the current
 * branch into N smaller branches, each with its own file set.
 *
 * Input context: the diff vs parent, commit subjects, commit count, file count.
 * Output: an array of proposed splits the user can preview before applying.
 *
 * @throws {DubError} If the model returns malformed JSON or empty proposals.
 */
export async function generateAiSplitProposal(
  input: {
    branch: string;
    parentBranch: string;
    diff: AiDiffContext;
    commitSubjects: string[];
    commitCount: number;
    fileCount: number;
    knownFiles: string[];
  },
  deps: AiMetadataDependencies,
  providerConfig: DubConfig['ai']['provider'],
): Promise<AiSplitProposal[]> {
  const resolved = resolveAiProvider({ deps, providerConfig });
  const prompt = [
    'You split one git branch into multiple smaller, semantically-coherent branches.',
    'Return JSON only — no markdown fences, no prose — matching exactly:',
    '{"splits":[{"branch":"feat/foo","files":["a.ts","b.ts"],"summary":"one-line summary"}, ...]}',
    'Rules:',
    '- Each branch must contain at least one file from KNOWN_FILES.',
    '- Every file MUST appear in exactly one branch. Do not duplicate files across branches.',
    '- Prefer 2-4 splits. Only return 1 split if the branch is already cohesive.',
    '- Branch names must be lowercase, slash-delimited, kebab-case. Use conventional prefixes (feat, fix, refactor, docs, test, chore) when obvious.',
    '- Summaries must be one short sentence describing the slice.',
    '- Do not invent files that are not in KNOWN_FILES.',
    '',
    `SOURCE_BRANCH: ${input.branch}`,
    `PARENT_BRANCH: ${input.parentBranch}`,
    `COMMIT_COUNT: ${input.commitCount}`,
    `FILE_COUNT: ${input.fileCount}`,
    '',
    'COMMIT_SUBJECTS_START',
    ...input.commitSubjects.map((s, i) => `${i + 1}. ${s}`),
    'COMMIT_SUBJECTS_END',
    '',
    'KNOWN_FILES_START',
    ...input.knownFiles,
    'KNOWN_FILES_END',
    '',
    'BRANCH_CHANGESET_CONTEXT_START',
    input.diff.promptPacket,
    'BRANCH_CHANGESET_CONTEXT_END',
  ].join('\n');

  const result = await deps.generateText({
    model: resolved.model,
    system:
      'You propose semantic git branch splits. Return strict JSON only with no extra commentary.',
    prompt,
  });

  return parseAiSplitResponse(result.text, input.knownFiles);
}

/**
 * Validates and normalizes an AI split response.
 *
 * Visible for testing.
 */
export function parseAiSplitResponse(
  text: string,
  knownFiles: string[],
): AiSplitProposal[] {
  const candidate = extractJsonObject(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new DubError('AI assistant returned invalid split proposal.', [
      "Rerun 'dub split --ai' to retry generation.",
      "Run 'dub split --by-file <files...>' to drive the split manually.",
    ]);
  }

  if (!parsed || typeof parsed !== 'object' || !('splits' in parsed)) {
    throw new DubError('AI assistant returned invalid split proposal.', [
      "Rerun 'dub split --ai' to retry generation.",
      "Run 'dub split --by-file <files...>' to drive the split manually.",
    ]);
  }

  const rawSplits = (parsed as { splits: unknown }).splits;
  if (!Array.isArray(rawSplits) || rawSplits.length === 0) {
    throw new DubError('AI assistant returned no split proposals.', [
      "Rerun 'dub split --ai' to retry generation.",
      "Run 'dub split --by-file <files...>' to drive the split manually.",
    ]);
  }

  const knownSet = new Set(knownFiles);
  const seenFiles = new Set<string>();
  const splits: AiSplitProposal[] = [];

  for (const raw of rawSplits) {
    if (!raw || typeof raw !== 'object') {
      throw new DubError('AI assistant returned malformed split entries.', [
        "Rerun 'dub split --ai' to retry generation.",
      ]);
    }
    const entry = raw as Record<string, unknown>;
    const branch = normalizeBranchName(stringOrEmpty(entry.branch));
    const summary = stringOrEmpty(entry.summary).trim();
    const filesRaw = entry.files;
    if (!Array.isArray(filesRaw) || filesRaw.length === 0) {
      throw new DubError('AI assistant proposed a split with no files.', [
        "Rerun 'dub split --ai' to retry generation.",
      ]);
    }
    const files: string[] = [];
    for (const f of filesRaw) {
      if (typeof f !== 'string') continue;
      const normalized = f.trim();
      if (!knownSet.has(normalized)) {
        throw new DubError(
          `AI assistant referenced unknown file '${normalized}'.`,
          [
            "Rerun 'dub split --ai' to retry generation.",
            "Run 'dub split --by-file <files...>' to drive the split manually.",
          ],
        );
      }
      if (seenFiles.has(normalized)) {
        throw new DubError(
          `AI assistant duplicated file '${normalized}' across proposed splits.`,
          ["Rerun 'dub split --ai' to retry generation."],
        );
      }
      seenFiles.add(normalized);
      files.push(normalized);
    }
    if (branch.length === 0) {
      throw new DubError('AI assistant returned an empty branch name.', [
        "Rerun 'dub split --ai' to retry generation.",
      ]);
    }
    splits.push({ branch, files, summary });
  }

  return splits;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeBranchName(value: string): string {
  return value
    .trim()
    .replace(/^`+|`+$/g, '')
    .replace(/^refs\/heads\//, '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9./_-]+/g, '-')
    .replace(/\/+/g, '/')
    .replace(/-+/g, '-')
    .replace(/^\/+|\/+$/g, '')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '');
}

function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  const withoutFences = stripMarkdownFences(trimmed);
  const start = withoutFences.indexOf('{');
  const end = withoutFences.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new DubError('AI assistant returned invalid split proposal.', [
      "Rerun 'dub split --ai' to retry generation.",
    ]);
  }
  return withoutFences.slice(start, end + 1);
}

function stripMarkdownFences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```') || !trimmed.endsWith('```')) {
    return trimmed;
  }
  return trimmed
    .replace(/^```(?:\w+)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

/**
 * Parses a "1 3 5" / "1,3,5" / "1-3,5" index spec into a sorted, deduped
 * 0-indexed array. Bounds are inclusive of 1..count.
 *
 * @throws {DubError} If any token is out of range or unparseable.
 */
export function parseIndexSelection(input: string, count: number): number[] {
  const cleaned = input.trim();
  if (cleaned.length === 0) return [];
  const tokens = cleaned.split(/[\s,]+/).filter(Boolean);
  const picks = new Set<number>();
  for (const token of tokens) {
    const rangeMatch = token.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const lo = Number.parseInt(rangeMatch[1], 10);
      const hi = Number.parseInt(rangeMatch[2], 10);
      if (
        !Number.isInteger(lo) ||
        !Number.isInteger(hi) ||
        lo < 1 ||
        hi > count ||
        lo > hi
      ) {
        throw new DubError(`Invalid commit range '${token}'.`, [
          `Pick numbers between 1 and ${count}, e.g. '1 3 5' or '1-3,5'.`,
        ]);
      }
      for (let i = lo; i <= hi; i++) picks.add(i - 1);
      continue;
    }
    const n = Number.parseInt(token, 10);
    if (!Number.isInteger(n) || n < 1 || n > count) {
      throw new DubError(`Invalid commit index '${token}'.`, [
        `Pick numbers between 1 and ${count}, e.g. '1 3 5' or '1-3,5'.`,
      ]);
    }
    picks.add(n - 1);
  }
  return Array.from(picks).sort((a, b) => a - b);
}
