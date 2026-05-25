import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { fromIni, fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { createGateway, generateText } from 'ai';
import { resolveAiProvider } from '../lib/ai-provider';
import { readConfig } from '../lib/config';
import { DubError } from '../lib/errors';
import {
  commitStaged,
  commitStagedFromFile,
  countCommitsAhead,
  getBranchTip,
  getCommitMessagesBetween,
  getCurrentBranch,
  isWorkingTreeClean,
  softResetTo,
} from '../lib/git';
import { getParent, readState } from '../lib/state';
import { withTempMarkdownFile } from '../lib/temp-text-file';
import { assertBranchesNotCheckedOutElsewhere } from '../lib/worktree-guards';
import { restack } from './restack';

export interface SquashOptions {
  /** Override the new commit message. Mutually exclusive with `--ai`. */
  message?: string;
  /** Generate a summary commit message from the squashed commits via AI. */
  ai?: boolean;
}

export interface SquashResult {
  branch: string;
  parent: string;
  /** Number of commits collapsed (0 when no-op). */
  squashedCommits: number;
  /** Commit message used for the new commit (undefined when no-op). */
  message?: string;
  /** True when restack ran successfully after the squash. */
  restacked: boolean;
  /** Set when the squash was a no-op for 0/1 commits. */
  noopReason?: 'no-commits' | 'single-commit';
}

interface SquashDependencies {
  generateText: typeof generateText;
  createGoogleGenerativeAI: typeof createGoogleGenerativeAI;
  createAnthropic?: typeof createAnthropic;
  createGateway: typeof createGateway;
  createAmazonBedrock?: typeof createAmazonBedrock;
  createOpenAI?: typeof createOpenAI;
  createOpenAICompatible?: typeof createOpenAICompatible;
  fromIni?: typeof fromIni;
  fromNodeProviderChain?: typeof fromNodeProviderChain;
}

const DEFAULT_DEPS: SquashDependencies = {
  generateText,
  createGoogleGenerativeAI,
  createAnthropic,
  createGateway,
  createAmazonBedrock,
  createOpenAI,
  createOpenAICompatible,
  fromIni,
  fromNodeProviderChain,
};

/**
 * Collapses every commit on the current branch (since its tracked parent) into
 * a single commit.
 *
 * - 0 or 1 commits → no-op with informational result.
 * - Otherwise → `git reset --soft <parent>` then commit using either the
 *   user-supplied message (`-m`), an AI-generated summary (`--ai`), or the
 *   concatenated original commit messages (most recent first).
 *
 * Descendants are restacked automatically once the squash succeeds, mirroring
 * how `dub modify` keeps the stack valid.
 *
 * @throws {DubError} If the working tree is dirty, the branch has no tracked
 *   parent, the option combination is invalid, the soft-reset/commit fails, or
 *   the AI assistant is requested but disabled.
 */
export async function squash(
  cwd: string,
  options: SquashOptions = {},
  deps: SquashDependencies = DEFAULT_DEPS,
): Promise<SquashResult> {
  if (options.ai && options.message) {
    throw new DubError("'--ai' cannot be combined with '-m'.", [
      "Drop '--ai' to use the message you supplied.",
      "Drop '-m' to let AI generate the squash message.",
    ]);
  }

  if (!(await isWorkingTreeClean(cwd))) {
    throw new DubError(
      'Working tree has uncommitted changes that would conflict with a squash.',
      [
        "Run 'git status' to see the uncommitted changes.",
        "Run 'git stash' to set the changes aside, then rerun 'dub squash'.",
        'Run \'dub modify -am "<message>"\' to commit the changes first.',
      ],
    );
  }

  const branch = await getCurrentBranch(cwd);
  const state = await readState(cwd);
  const parent = getParent(state, branch);
  if (!parent) {
    throw new DubError(`Could not determine parent branch for '${branch}'.`, [
      `Run 'dub track ${branch} --parent <branch>' to set the parent.`,
      "Run 'dub log' to inspect the stack and confirm tracking state.",
    ]);
  }
  await assertBranchesNotCheckedOutElsewhere(cwd, [branch], 'dub squash');

  const commitCount = await countCommitsAhead(branch, parent, cwd);
  if (commitCount <= 1) {
    return {
      branch,
      parent,
      squashedCommits: 0,
      restacked: false,
      noopReason: commitCount === 0 ? 'no-commits' : 'single-commit',
    };
  }

  const originalMessages = await getCommitMessagesBetween(parent, branch, cwd);

  let message: string;
  if (options.message?.trim()) {
    message = options.message.trim();
  } else if (options.ai) {
    const config = await readConfig(cwd);
    if (!config.aiAssistantEnabled) {
      throw new DubError('AI assistant is disabled for this repo.', [
        "Run 'dub config ai-assistant on' to enable AI for this repo.",
        `Rerun 'dub squash -m "<message>"' without '--ai'.`,
      ]);
    }
    message = await generateAiSquashMessage(
      { branch, originalMessages },
      deps,
      config.ai.provider,
    );
  } else {
    message = originalMessages.join('\n\n');
  }

  const parentTip = await getBranchTip(parent, cwd);
  await softResetTo(parentTip, cwd);

  try {
    if (message.includes('\n')) {
      await withTempMarkdownFile('squash-message', message, async (file) => {
        await commitStagedFromFile(file, cwd);
      });
    } else {
      await commitStaged(message, cwd);
    }
  } catch (error) {
    const reason = error instanceof DubError ? error.message : String(error);
    throw new DubError(
      `Soft-reset succeeded but the squash commit failed: ${reason}.`,
      [
        `Run 'git commit' manually to inspect pre-commit hook output; staged changes are preserved.`,
        `Run 'git reset --hard ORIG_HEAD' to restore the original commits if you want to abort.`,
      ],
    );
  }

  let restacked = false;
  try {
    const restackResult = await restack(cwd);
    restacked = restackResult.rebased.length > 0;
  } catch (e) {
    if (e instanceof DubError && e.message.includes('Conflict')) {
      console.log(
        '⚠ Squash successful, but auto-restacking encountered conflicts.',
      );
      console.log("  Run 'dub restack --continue' to resolve.");
    } else {
      console.log('⚠ Squash successful, but auto-restacking failed.');
      console.log(`  ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return {
    branch,
    parent,
    squashedCommits: commitCount,
    message,
    restacked,
  };
}

async function generateAiSquashMessage(
  input: { branch: string; originalMessages: string[] },
  deps: SquashDependencies,
  providerConfig: Parameters<typeof resolveAiProvider>[0]['providerConfig'],
): Promise<string> {
  const resolved = resolveAiProvider({ deps, providerConfig });
  const prompt = [
    'Summarize the following commits as a single Conventional Commit message.',
    'Rules:',
    '- Output only the message: a Conventional Commit subject line, optionally followed by a body.',
    '- Subject line must match `<type>(optional-scope)?: <description>` using one of feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert.',
    '- Keep the subject under 72 characters when possible.',
    '- Use the body for context only when the commits change multiple things worth calling out.',
    '- Do not include markdown fences, quotes, or commentary.',
    '',
    `Branch: ${input.branch}`,
    '',
    'COMMITS_START',
    ...input.originalMessages.map(
      (m, i) => `--- commit ${i + 1} (most recent first) ---\n${m}`,
    ),
    'COMMITS_END',
  ].join('\n');

  const result = await deps.generateText({
    model: resolved.model,
    system:
      'You write concise Conventional Commit messages. Output the message only, no commentary or fences.',
    prompt,
  });

  const summary = stripFences(result.text.trim());
  if (summary.length === 0) {
    throw new DubError('AI assistant generated an empty squash message.', [
      "Rerun 'dub squash --ai' to retry generation.",
      `Rerun 'dub squash -m "<message>"' to supply the message manually.`,
    ]);
  }
  return summary;
}

function stripFences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```') || !trimmed.endsWith('```')) {
    return trimmed;
  }
  return trimmed
    .replace(/^```(?:\w+)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}
