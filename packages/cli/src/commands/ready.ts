import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { fromIni, fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { createGateway, generateText } from 'ai';
import {
  type AiReadinessDependencies,
  type AiReadinessIssue,
  aiReviewBranch,
} from '../lib/ai-readiness';
import { readConfig } from '../lib/config';
import { DubError } from '../lib/errors';
import { getCommitMessagesBetween, getDiffBetween } from '../lib/git';
import { getPr } from '../lib/github';
import type { ScopeMode } from '../lib/scope';
import { doctor } from './doctor';
import { getSubmitPlan, type SubmitOptions, type SubmitScope } from './submit';

export interface ReadyAiBranchResult {
  branch: string;
  baseBranch: string;
  issues: AiReadinessIssue[];
}

export interface ReadyAiReviewResult {
  skipped: boolean;
  branches: ReadyAiBranchResult[];
}

export interface ReadyResult {
  ready: boolean;
  scope: ScopeMode;
  checkedBranch: string;
  submitBranches: string[];
  submitScope: SubmitScope | null;
  rootBranch: string | null;
  blockers: string[];
  aiReview: ReadyAiReviewResult | null;
}

export interface ReadyOptions {
  scope?: ScopeMode;
  ai?: boolean;
  aiSkipReview?: boolean;
}

const DEFAULT_AI_DEPS: AiReadinessDependencies = {
  generateText,
  createGoogleGenerativeAI,
  createGateway,
  createAmazonBedrock,
  fromIni,
  fromNodeProviderChain,
};

export async function ready(
  cwd: string,
  options: ReadyOptions = {},
  aiDeps: AiReadinessDependencies = DEFAULT_AI_DEPS,
): Promise<ReadyResult> {
  const scope = options.scope ?? 'downstack';
  const doctorResult = await doctor(cwd);
  const blockers: string[] = doctorResult.issues.map((issue) => issue.code);

  let submitBranches: string[] = [];
  let submitScope: SubmitScope | null = null;
  let rootBranch: string | null = null;
  let aiReview: ReadyAiReviewResult | null = null;
  let selectedBranches: Array<{
    name: string;
    parent?: string | null;
  }> = [];

  try {
    // 'current' uses downstack and narrows to the current branch below;
    // 'downstack' and 'stack' map directly to submit's same-named scopes.
    const planOptions: SubmitOptions =
      scope === 'stack' ? { stack: true } : { downstack: true };
    const plan = await getSubmitPlan(cwd, planOptions);
    submitScope = plan.scope;
    rootBranch = plan.rootBranch;

    const planBranches = plan.branches.map((b) => b.name);
    submitBranches =
      scope === 'current'
        ? planBranches.filter((name) => name === plan.currentBranch)
        : planBranches;
    selectedBranches =
      scope === 'current'
        ? plan.branches.filter((branch) => branch.name === plan.currentBranch)
        : plan.branches;

    if (submitBranches.length === 0) {
      blockers.push('submit-preflight');
    }
  } catch {
    blockers.push('submit-preflight');
  }

  if (options.ai && selectedBranches.length > 0) {
    const config = await readConfig(cwd);
    if (!config.aiAssistantEnabled) {
      throw new DubError('AI assistant is disabled for this repo.', [
        "Run 'dub config ai-assistant on' to enable AI for this repo.",
        "Rerun 'dub ready' to skip the AI readiness review.",
      ]);
    } else {
      const branches = await Promise.all(
        selectedBranches.map(async (branch) => {
          const baseBranch = branch.parent ?? rootBranch ?? '';
          const diff = await getDiffBetween(baseBranch, branch.name, cwd);
          const commitMessages = await getCommitMessagesBetween(
            baseBranch,
            branch.name,
            cwd,
          );
          const prDescription = await getPrDescription(branch.name, cwd);
          const issues = await aiReviewBranch(
            {
              branch: branch.name,
              baseBranch,
              diff,
              commitMessages,
              prDescription,
            },
            aiDeps,
            config.ai.provider,
          );

          return {
            branch: branch.name,
            baseBranch,
            issues,
          };
        }),
      );
      aiReview = {
        skipped: options.aiSkipReview === true,
        branches,
      };

      if (
        !aiReview.skipped &&
        branches.some((branch) =>
          branch.issues.some((issue) => issue.severity === 'critical'),
        )
      ) {
        blockers.push('ai-review');
      }
    }
  }

  return {
    ready: blockers.length === 0,
    scope,
    checkedBranch: doctorResult.checkedBranch,
    submitBranches,
    submitScope,
    rootBranch,
    blockers: Array.from(new Set(blockers)),
    aiReview,
  };
}

async function getPrDescription(
  branch: string,
  cwd: string,
): Promise<string | null> {
  try {
    return (await getPr(branch, cwd))?.body ?? null;
  } catch {
    return null;
  }
}
