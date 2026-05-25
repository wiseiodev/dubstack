import type { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import type { createAnthropic } from '@ai-sdk/anthropic';
import type { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { createOpenAI } from '@ai-sdk/openai';
import type {
  fromIni,
  fromNodeProviderChain,
} from '@aws-sdk/credential-providers';
import type { createGateway, generateText } from 'ai';
import {
  type AiDiffContext,
  type AiDiffContextInput,
  buildAiDiffContext,
} from './ai-diff-context';
import { resolveAiProvider } from './ai-provider';
import type { DubConfig } from './config';
import { DubError } from './errors';

export interface AiMetadataDependencies {
  generateText: typeof generateText;
  createGoogleGenerativeAI: typeof createGoogleGenerativeAI;
  createAnthropic?: typeof createAnthropic;
  createGateway: typeof createGateway;
  createAmazonBedrock?: typeof createAmazonBedrock;
  createOpenAI?: typeof createOpenAI;
  fromIni?: typeof fromIni;
  fromNodeProviderChain?: typeof fromNodeProviderChain;
}

export interface PrDescriptionContext {
  branch: string;
  baseBranch: string;
  commitMessage: string;
  diff: AiDiffContext | string | AiDiffContextInput;
}

export interface AiMetadataTemplates {
  prTemplate?: string | null;
  commitTemplate?: string | null;
}

export interface FlowMetadataInput {
  parentBranch: string;
  staged: AiDiffContext;
}

const CONVENTIONAL_COMMIT_RE =
  /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]+\))?!?: .+/;

export async function generateCreateMetadata(
  stagedDiff: AiDiffContext | string | AiDiffContextInput,
  deps: AiMetadataDependencies,
  templates: AiMetadataTemplates = {},
  providerConfig: DubConfig['ai']['provider'],
): Promise<{ branch: string; message: string }> {
  const resolved = resolveAiProvider({ deps, providerConfig });
  const diffContext = resolveAiDiffContext(stagedDiff);
  const prompt = [
    'Generate a git branch name and conventional commit message for the entire staged change set.',
    'Return JSON only, exactly like: {"branch":"feat/your-branch","message":"feat: summary"}',
    'Rules:',
    '- consider the entire staged change set, not just the first files in the diff.',
    '- choose the branch and commit headline based on the dominant implementation change.',
    '- runtime or product-behavior changes outrank tests, docs, skills, and plans when multiple categories are present.',
    '- docs, tests, skills, and plans should usually stay in the commit body or supporting context unless they are the primary work.',
    '- branch must be lowercase, slash-delimited, and kebab-case.',
    '- message must be a Conventional Commit subject line.',
    '- choose the branch/message type that matches the dominant change intent: feat for new functionality, fix for bug fixes, refactor for internal cleanup, docs for documentation-only changes, and test for test-only changes.',
    '- if a repository commit template is provided, preserve its structure in the generated commit message body.',
    '- keep message under 72 characters when possible.',
    '- do not include markdown fences.',
    '',
    ...buildTemplatePromptSection(
      'REPOSITORY_COMMIT_TEMPLATE',
      templates.commitTemplate,
    ),
    ...((templates.commitTemplate?.trim().length ?? 0) > 0 ? [''] : []),
    'STAGED_CHANGE_CONTEXT_START',
    diffContext.promptPacket,
    'STAGED_CHANGE_CONTEXT_END',
  ].join('\n');

  const result = await deps.generateText({
    model: resolved.model,
    system:
      'You produce concise git metadata. Output strict JSON only and never add extra commentary.',
    prompt,
  });

  return parseAiCreateResponse(result.text);
}

export async function generatePrDescriptionSummary(
  context: PrDescriptionContext,
  deps: AiMetadataDependencies,
  templates: AiMetadataTemplates = {},
  providerConfig: DubConfig['ai']['provider'],
): Promise<string> {
  const resolved = resolveAiProvider({ deps, providerConfig });
  const diffContext = resolveAiDiffContext(context.diff);
  const prompt = [
    'Write a concise pull request description in markdown.',
    'Rules:',
    '- Consider the entire change set, not just the first files in git diff output.',
    '- Lead with the dominant implementation change when runtime or product behavior changed.',
    '- Still cover materially changed docs, tests, skills, plans, or config in supporting sections when they are part of the change set.',
    '- Do not include a title line; the PR title is managed separately.',
    '- Do not include HTML comments or markdown fences.',
    '- Keep it readable in a terminal markdown preview.',
    '- If a repository PR template is provided, keep its headings and section order.',
    '',
    `Branch: ${context.branch}`,
    `Base branch: ${context.baseBranch}`,
    `Commit message: ${context.commitMessage}`,
    '',
    ...buildTemplatePromptSection(
      'REPOSITORY_PR_TEMPLATE',
      templates.prTemplate,
    ),
    ...((templates.prTemplate?.trim().length ?? 0) > 0 ? [''] : []),
    'BRANCH_CHANGESET_CONTEXT_START',
    diffContext.promptPacket,
    'BRANCH_CHANGESET_CONTEXT_END',
  ].join('\n');

  const result = await deps.generateText({
    model: resolved.model,
    system:
      'You write concise pull request descriptions in markdown. Return markdown only with no extra commentary.',
    prompt,
  });

  const summary = result.text.trim();
  if (summary.length === 0) {
    throw new DubError('AI assistant generated an empty PR description.', [
      "Rerun 'dub submit --ai' to retry generation.",
      "Rerun 'dub submit --no-ai' to skip AI for this run.",
    ]);
  }

  return stripMarkdownFences(summary);
}

export async function generateFlowMetadata(
  input: FlowMetadataInput,
  deps: AiMetadataDependencies,
  templates: AiMetadataTemplates = {},
  providerConfig: DubConfig['ai']['provider'],
): Promise<{
  branch: string;
  commitMessage: string;
  prDescription: string;
}> {
  const generated = await generateCreateMetadata(
    input.staged,
    deps,
    templates,
    providerConfig,
  );
  const prDescription = await generatePrDescriptionSummary(
    {
      branch: generated.branch,
      baseBranch: input.parentBranch,
      commitMessage: generated.message,
      diff: input.staged,
    },
    deps,
    templates,
    providerConfig,
  );

  return {
    branch: generated.branch,
    commitMessage: generated.message,
    prDescription,
  };
}

function parseAiCreateResponse(text: string): {
  branch: string;
  message: string;
} {
  const candidate = extractJsonObject(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new DubError('AI assistant returned invalid metadata.', [
      "Rerun 'dub create --ai' to retry generation.",
      'Rerun \'dub create <branch> -m "<message>"\' to pass branch and message manually.',
    ]);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new DubError('AI assistant returned invalid metadata.', [
      "Rerun 'dub create --ai' to retry generation.",
      'Rerun \'dub create <branch> -m "<message>"\' to pass branch and message manually.',
    ]);
  }

  const rawBranch = getStringValue(parsed, 'branch');
  const rawMessage = getStringValue(parsed, 'message');
  const branch = normalizeBranchName(rawBranch);
  const message = normalizeCommitMessage(rawMessage);
  const subjectLine = message.split('\n')[0]?.trim() ?? '';

  if (branch.length === 0) {
    throw new DubError('AI assistant generated an empty branch name.', [
      "Rerun 'dub create --ai' to retry generation.",
      "Rerun 'dub create <branch>' to set the branch name manually.",
    ]);
  }

  if (!CONVENTIONAL_COMMIT_RE.test(subjectLine)) {
    throw new DubError(
      'AI assistant generated a non-conventional commit message.',
      [
        "Rerun 'dub create --ai' to retry generation.",
        'Rerun \'dub create <branch> -m "<message>"\' to pass a conventional commit message manually.',
      ],
    );
  }

  return { branch, message };
}

function getStringValue(source: object, key: string): string {
  const value = (source as Record<string, unknown>)[key];
  if (typeof value !== 'string') {
    throw new DubError(`AI assistant metadata is missing '${key}'.`, [
      "Rerun 'dub create --ai' to retry generation.",
      'Rerun \'dub create <branch> -m "<message>"\' to pass branch and message manually.',
    ]);
  }
  return value;
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

function normalizeCommitMessage(value: string): string {
  const normalized = value
    .trim()
    .replace(/^`+|`+$/g, '')
    .replace(/\r\n/g, '\n');
  const [subjectLine = '', ...bodyLines] = normalized.split('\n');
  const subject = subjectLine.replace(/\s+/g, ' ').trim();
  const body = bodyLines.join('\n').trim();
  return body.length > 0 ? `${subject}\n\n${body}` : subject;
}

function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  const withoutFences = stripMarkdownFences(trimmed);
  const start = withoutFences.indexOf('{');
  const end = withoutFences.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new DubError('AI assistant returned invalid metadata.', [
      "Rerun 'dub create --ai' to retry generation.",
      'Rerun \'dub create <branch> -m "<message>"\' to pass branch and message manually.',
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

function buildTemplatePromptSection(
  label: string,
  template: string | null | undefined,
): string[] {
  const trimmed = template?.trim();
  if (!trimmed) return [];
  return [`${label}_START`, trimmed, `${label}_END`];
}

function resolveAiDiffContext(
  value: AiDiffContext | string | AiDiffContextInput,
): AiDiffContext {
  if (typeof value === 'string') {
    return buildAiDiffContext({ rawDiff: value });
  }

  if ('promptPacket' in value) {
    return value;
  }

  return buildAiDiffContext(value);
}
