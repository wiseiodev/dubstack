import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { fromIni, fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { createGateway, generateText } from 'ai';
import { buildAiDiffContext } from '../lib/ai-diff-context';
import {
  type AiMetadataDependencies,
  generateCreateMetadata,
} from '../lib/ai-metadata';
import { appendCheckoutHistory } from '../lib/checkout-history';
import { readConfig } from '../lib/config';
import { DubError } from '../lib/errors';
import {
  branchExists,
  commitStaged,
  commitStagedFromFile,
  createBranch,
  getBranchTip,
  getCurrentBranch,
  getDiff,
  getDiffFileNames,
  getDiffNumStat,
  hasStagedChanges,
  interactiveStage,
  isValidBranchName,
  stageAll,
  stageUpdate,
} from '../lib/git';
import { readMetadataTemplates } from '../lib/metadata-templates';
import { addBranchToStack, ensureState, writeState } from '../lib/state';
import { withTempMarkdownFile } from '../lib/temp-text-file';
import { saveUndoEntry } from '../lib/undo-log';

interface CreateOptions {
  ai?: boolean;
  noAi?: boolean;
  message?: string;
  all?: boolean;
  update?: boolean;
  patch?: boolean;
}

interface CreateResult {
  branch: string;
  parent: string;
  committed?: string;
}

type CreateDependencies = AiMetadataDependencies;

const DEFAULT_DEPS: CreateDependencies = {
  generateText,
  createGoogleGenerativeAI,
  createGateway,
  createAmazonBedrock,
  fromIni,
  fromNodeProviderChain,
};

/**
 * Creates a new branch stacked on top of the current branch.
 *
 * When `-m` is provided, also commits staged changes on the new branch.
 * When `-a/-u/-p` are provided, stages changes first (requires `-m` or `--ai`).
 * When `--ai` is provided, branch + commit message are generated from staged changes.
 *
 * @param name - Name of the new branch to create
 * @param cwd - Working directory (auto-initializes if needed)
 * @param options - Optional create flags
 * @returns The created branch name, its parent, and committed message if applicable
 * @throws {DubError} If branch exists, HEAD is detached, invalid option combos, or nothing to commit
 */
export async function create(
  name: string | undefined,
  cwd: string,
  options?: CreateOptions,
  deps: CreateDependencies = DEFAULT_DEPS,
): Promise<CreateResult> {
  const normalizedOptions = options ?? {};

  if (normalizedOptions.ai && normalizedOptions.noAi) {
    throw new DubError("'--ai' cannot be combined with '--no-ai'.", [
      "Pass '--ai' alone to AI-generate the branch and commit.",
      "Pass '--no-ai' alone to skip AI generation for this run.",
    ]);
  }

  const config = await readConfig(cwd);
  const useAi =
    normalizedOptions.ai === true
      ? true
      : normalizedOptions.noAi === true
        ? false
        : config.ai.defaults.createMetadata;

  if (
    (normalizedOptions.all ||
      normalizedOptions.update ||
      normalizedOptions.patch) &&
    !normalizedOptions.message &&
    !useAi
  ) {
    throw new DubError(
      "'--all', '--update', and '--patch' require '-m' or '--ai'.",
      [
        "Pass '-m \"<message>\"' alongside '--all', '--update', or '--patch'.",
        "Pass '--ai' to let DubStack generate the commit message.",
      ],
    );
  }

  if (useAi && normalizedOptions.message) {
    throw new DubError("'--ai' cannot be combined with '-m'.", [
      "Drop '--ai' to use the message you supplied.",
      "Drop '-m' to let AI generate the commit message.",
    ]);
  }

  if (!useAi && !name?.trim()) {
    throw new DubError('Branch name is required.', [
      "Pass '<branch-name>' as the first argument to 'dub create'.",
      "Pass '--ai' to AI-generate the branch name from staged changes.",
    ]);
  }

  if (useAi && name?.trim()) {
    throw new DubError("Do not pass <branch-name> with '--ai'.", [
      "Drop the branch argument and let '--ai' generate the name from staged changes.",
      "Drop '--ai' to keep the explicit branch name you supplied.",
    ]);
  }

  const state = await ensureState(cwd);
  const parent = await getCurrentBranch(cwd);
  let branchName = name?.trim();
  let commitMessage = normalizedOptions.message?.trim();

  if (commitMessage || useAi) {
    if (normalizedOptions.patch) {
      await interactiveStage(cwd);
    } else if (normalizedOptions.all) {
      await stageAll(cwd);
    } else if (normalizedOptions.update) {
      await stageUpdate(cwd);
    }

    if (!(await hasStagedChanges(cwd))) {
      const isAggregateFlag =
        normalizedOptions.all ||
        normalizedOptions.update ||
        normalizedOptions.patch;
      const message = isAggregateFlag
        ? 'No changes to commit.'
        : 'No staged changes.';
      const recovery: string[] = isAggregateFlag
        ? [
            "Edit and save the files you want to commit, then rerun 'dub create'.",
            "Run 'git status' to confirm the working tree has changes.",
          ]
        : useAi
          ? [
              "Run 'git add <files>' to stage the changes you want to commit.",
              "Rerun 'dub create -a --ai' to stage all changes and generate metadata.",
            ]
          : [
              "Run 'git add <files>' to stage the changes you want to commit.",
              'Rerun \'dub create -a -m "<message>"\' to stage all changes at once.',
            ];
      throw new DubError(message, recovery);
    }
  }

  if (useAi) {
    if (!config.aiAssistantEnabled) {
      throw new DubError('AI assistant is disabled for this repo.', [
        "Run 'dub config ai-assistant on' to enable AI for this repo.",
        "Rerun 'dub create <branch> -m \"<message>\"' without '--ai'.",
      ]);
    }

    const stagedDiff = await getDiff(cwd, true);
    const [stagedFiles, stagedDiffStats] = await Promise.all([
      getDiffFileNames(cwd, true),
      getDiffNumStat(cwd, true),
    ]);
    const templates = await readMetadataTemplates(cwd);
    const generated = await generateCreateMetadata(
      buildAiDiffContext({
        rawDiff: stagedDiff,
        filePaths: stagedFiles,
        diffStats: stagedDiffStats,
      }),
      deps,
      {
        commitTemplate: templates.commitTemplate,
      },
      config.ai.provider,
    );
    branchName = generated.branch;
    commitMessage = generated.message;
  }

  if (!branchName) {
    throw new DubError('Branch name is required.', [
      "Pass '<branch-name>' as the first argument to 'dub create'.",
      "Pass '--ai' to AI-generate the branch name from staged changes.",
    ]);
  }

  if (!(await isValidBranchName(branchName, cwd))) {
    throw new DubError(`Branch name '${branchName}' is invalid.`, [
      'Use only ASCII letters, digits, slashes, dots, dashes, and underscores.',
      'Avoid leading dashes, double-dots, and trailing slashes; rerun with a new name.',
    ]);
  }

  if (await branchExists(branchName, cwd)) {
    throw new DubError(`Branch '${branchName}' already exists.`, [
      `Run 'dub checkout ${branchName}' to switch to the existing branch.`,
      "Rerun 'dub create <branch>' with a different name.",
      `Run 'dub delete ${branchName}' to remove the existing branch first.`,
    ]);
  }

  await saveUndoEntry(
    {
      operation: 'create',
      timestamp: new Date().toISOString(),
      previousBranch: parent,
      previousState: structuredClone(state),
      branchTips: {},
      createdBranches: [branchName],
    },
    cwd,
  );

  const parentRevision = await getBranchTip(parent, cwd);
  await createBranch(branchName, cwd);
  addBranchToStack(state, branchName, parent, parentRevision);
  await writeState(state, cwd);
  await appendCheckoutHistory(cwd, branchName, { via: 'create' });

  if (commitMessage) {
    try {
      if (commitMessage.includes('\n')) {
        await withTempMarkdownFile(
          'commit-message',
          commitMessage,
          async (filePath) => {
            await commitStagedFromFile(filePath, cwd);
          },
        );
      } else {
        await commitStaged(commitMessage, cwd);
      }
    } catch (error) {
      const reason = error instanceof DubError ? error.message : String(error);
      throw new DubError(
        `Branch '${branchName}' was created but commit failed: ${reason}.`,
        [
          "Run 'dub undo' to roll back the branch creation.",
          'Resolve the underlying commit error and rerun the same create command.',
        ],
      );
    }
    return { branch: branchName, parent, committed: commitMessage };
  }

  return { branch: branchName, parent };
}
