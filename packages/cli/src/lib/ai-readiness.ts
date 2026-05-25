import type { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import type { createGoogleGenerativeAI } from '@ai-sdk/google';
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

export type AiReadinessSeverity = 'critical' | 'major' | 'minor';

export interface AiReadinessIssue {
  severity: AiReadinessSeverity;
  message: string;
  action: string;
}

export interface AiReadinessBranchInput {
  branch: string;
  baseBranch: string;
  diff: AiDiffContext | string | AiDiffContextInput;
  commitMessages: string[];
  prDescription: string | null;
}

export interface AiReadinessDependencies {
  generateText: typeof generateText;
  createGoogleGenerativeAI: typeof createGoogleGenerativeAI;
  createGateway: typeof createGateway;
  createAmazonBedrock?: typeof createAmazonBedrock;
  fromIni?: typeof fromIni;
  fromNodeProviderChain?: typeof fromNodeProviderChain;
}

export async function aiReviewBranch(
  input: AiReadinessBranchInput,
  deps: AiReadinessDependencies,
  providerConfig: DubConfig['ai']['provider'],
): Promise<AiReadinessIssue[]> {
  const resolved = resolveAiProvider({ deps, providerConfig });
  const diffContext = resolveDiffContext(input.diff);
  const prompt = [
    'Review this branch for pre-submit readiness.',
    'Return JSON only, exactly like:',
    '[{"severity":"major","message":"Short finding","action":"Concrete next step"}]',
    'Rules:',
    '- Return an empty array when the branch is ready to submit.',
    '- Use severity critical only when the branch should not be submitted.',
    '- Use severity major for important warnings that can still be overridden.',
    '- Use severity minor for low-risk polish or heuristic concerns.',
    '- Focus on the top actionable issues, sorted by severity.',
    '- Check commit messages for Conventional Commit subject quality and useful bodies.',
    '- Check PR description completeness and TODO/TBD/FIXME placeholders.',
    '- Check for functions/classes touched without corresponding test changes in the same diff; this is heuristic, not authoritative.',
    '- Check for obvious style or accessibility smells, but do not pretend to be a full code reviewer.',
    '- Do not include markdown fences or commentary.',
    '',
    `Branch: ${input.branch}`,
    `Base branch: ${input.baseBranch}`,
    '',
    'COMMIT_MESSAGES_START',
    input.commitMessages.length > 0
      ? input.commitMessages.join('\n---\n')
      : '(no commits found)',
    'COMMIT_MESSAGES_END',
    '',
    'PR_DESCRIPTION_START',
    input.prDescription?.trim() || '(no open PR description found)',
    'PR_DESCRIPTION_END',
    '',
    'BRANCH_CHANGESET_CONTEXT_START',
    diffContext.promptPacket,
    'BRANCH_CHANGESET_CONTEXT_END',
  ].join('\n');

  const result = await deps.generateText({
    model: resolved.model,
    system:
      'You are a strict pre-submit readiness judge. Return strict JSON only.',
    prompt,
  });

  return parseAiReadinessIssues(result.text);
}

function resolveDiffContext(
  diff: AiDiffContext | string | AiDiffContextInput,
): AiDiffContext {
  if (typeof diff === 'string') return buildAiDiffContext({ rawDiff: diff });
  if ('promptPacket' in diff) return diff;
  return buildAiDiffContext(diff);
}

function parseAiReadinessIssues(text: string): AiReadinessIssue[] {
  const candidate = extractJsonArray(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new DubError('AI readiness review returned invalid JSON.', [
      "Rerun 'dub ready --ai' to retry the review.",
      "Rerun 'dub ready --ai --ai-skip-review' if you need to bypass the review gate.",
    ]);
  }

  if (!Array.isArray(parsed)) {
    throw new DubError('AI readiness review returned invalid issues.', [
      "Rerun 'dub ready --ai' to retry the review.",
      "Rerun 'dub ready --ai --ai-skip-review' if you need to bypass the review gate.",
    ]);
  }

  return parsed.map((item) => normalizeIssue(item));
}

function normalizeIssue(item: unknown): AiReadinessIssue {
  if (!item || typeof item !== 'object') {
    throw invalidIssueError();
  }

  const record = item as Record<string, unknown>;
  const severity = record.severity;
  const message = record.message;
  const action = record.action;
  if (severity !== 'critical' && severity !== 'major' && severity !== 'minor') {
    throw invalidIssueError();
  }
  if (typeof message !== 'string' || message.trim().length === 0) {
    throw invalidIssueError();
  }
  if (typeof action !== 'string' || action.trim().length === 0) {
    throw invalidIssueError();
  }

  return {
    severity,
    message: message.trim(),
    action: action.trim(),
  };
}

function invalidIssueError(): DubError {
  return new DubError('AI readiness review returned malformed issues.', [
    "Rerun 'dub ready --ai' to retry the review.",
    "Rerun 'dub ready --ai --ai-skip-review' if you need to bypass the review gate.",
  ]);
}

function extractJsonArray(text: string): string {
  let json = text.trim();
  const fenceMatch = json.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch?.[1]) {
    json = fenceMatch[1].trim();
  }

  const arrayStart = json.indexOf('[');
  const arrayEnd = json.lastIndexOf(']');
  if (arrayStart !== -1 && arrayEnd !== -1 && arrayEnd > arrayStart) {
    return json.slice(arrayStart, arrayEnd + 1);
  }

  return json;
}
