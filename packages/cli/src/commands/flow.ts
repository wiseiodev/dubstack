import * as fs from 'node:fs';
import { stdin as input, stdout as output } from 'node:process';
import * as readline from 'node:readline/promises';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { fromIni, fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { createGateway, generateText } from 'ai';
import { execa } from 'execa';
import { buildAiDiffContext } from '../lib/ai-diff-context';
import {
  type AiMetadataDependencies,
  generateFlowMetadata,
} from '../lib/ai-metadata';
import { readConfig } from '../lib/config';
import { DubError } from '../lib/errors';
import {
  commitStagedFromFile,
  getCurrentBranch,
  getDiff,
  getDiffFileNames,
  getDiffNumStat,
  hasStagedChanges,
  interactiveStage,
  stageAll,
  stageUpdate,
} from '../lib/git';
import { readMetadataTemplates } from '../lib/metadata-templates';
import {
  removeTempFile,
  withTempMarkdownFile,
  writeTempMarkdownFile,
} from '../lib/temp-text-file';
import { createTerminalRenderer } from '../lib/terminal-render';
import { create } from './create';
import { type SubmitResult, submit } from './submit';

type ApprovalChoice = 'approve' | 'edit' | 'cancel';

export interface FlowOptions {
  ai?: boolean;
  noAi?: boolean;
  yes?: boolean;
  all?: boolean;
  update?: boolean;
  patch?: boolean;
  dryRun?: boolean;
}

export interface FlowResult {
  branch: string;
  commitMessage: string;
  prDescription: string;
  dryRun: boolean;
  aborted: boolean;
  submitted?: SubmitResult;
}

interface TerminalRendererLike {
  renderMarkdown: (markdown: string) => void;
  renderPreview: (title: string, markdown: string) => void;
  renderStatus: (status: string) => void;
  renderToolActivity: (toolName: string, detail?: string) => void;
}

interface FlowDependencies extends AiMetadataDependencies {
  generateFlowMetadata: typeof generateFlowMetadata;
  readMetadataTemplates: typeof readMetadataTemplates;
  readConfig: typeof readConfig;
  getCurrentBranch: typeof getCurrentBranch;
  hasStagedChanges: typeof hasStagedChanges;
  stageAll: typeof stageAll;
  stageUpdate: typeof stageUpdate;
  interactiveStage: typeof interactiveStage;
  getDiff: typeof getDiff;
  getDiffFileNames: typeof getDiffFileNames;
  getDiffNumStat: typeof getDiffNumStat;
  create: typeof create;
  submit: typeof submit;
  commitStagedFromFile: typeof commitStagedFromFile;
  createTerminalRenderer: typeof createTerminalRenderer;
  promptApproval: () => Promise<ApprovalChoice>;
  editGeneratedContent: (
    cwd: string,
    content: { commitMessage: string; prDescription: string },
  ) => Promise<{ commitMessage: string; prDescription: string }>;
}

const DEFAULT_DEPS: FlowDependencies = {
  generateText,
  createGoogleGenerativeAI,
  createGateway,
  createAmazonBedrock,
  fromIni,
  fromNodeProviderChain,
  generateFlowMetadata,
  readMetadataTemplates,
  readConfig,
  getCurrentBranch,
  hasStagedChanges,
  stageAll,
  stageUpdate,
  interactiveStage,
  getDiff,
  getDiffFileNames,
  getDiffNumStat,
  create,
  submit,
  commitStagedFromFile,
  createTerminalRenderer,
  promptApproval: promptApprovalChoice,
  editGeneratedContent: editGeneratedContent,
};

export async function flow(
  cwd: string,
  options: FlowOptions = {},
  deps: Partial<FlowDependencies> = {},
): Promise<FlowResult> {
  const resolvedDeps: FlowDependencies = {
    ...DEFAULT_DEPS,
    ...deps,
  };

  if (options.ai && options.noAi) {
    throw new DubError("'--ai' cannot be combined with '--no-ai'.");
  }

  validateStageMode(options);

  const config = await resolvedDeps.readConfig(cwd);
  const useAi =
    options.ai === true
      ? true
      : options.noAi === true
        ? false
        : config.ai.defaults.flow;

  if (!useAi) {
    throw new DubError(
      "dub flow requires AI. Re-run with '--ai' or enable it with 'dub config ai-defaults flow on'.",
    );
  }

  if (!config.aiAssistantEnabled) {
    throw new DubError(
      "AI assistant is disabled for this repo. Enable it with 'dub config ai-assistant on'.",
    );
  }

  await stageChanges(cwd, options, resolvedDeps);

  if (!(await resolvedDeps.hasStagedChanges(cwd))) {
    throw new DubError(
      "No staged changes. Stage files with 'git add' or rerun with '-a', '-u', or '-p'.",
    );
  }

  const parentBranch = await resolvedDeps.getCurrentBranch(cwd);
  const stagedDiff = await resolvedDeps.getDiff(cwd, true);
  const [stagedFiles, stagedDiffStats] = await Promise.all([
    resolvedDeps.getDiffFileNames(cwd, true),
    resolvedDeps.getDiffNumStat(cwd, true),
  ]);
  const templates = await resolvedDeps.readMetadataTemplates(cwd);
  const generated = await resolvedDeps.generateFlowMetadata(
    {
      parentBranch,
      staged: buildAiDiffContext({
        rawDiff: stagedDiff,
        filePaths: stagedFiles,
        diffStats: stagedDiffStats,
      }),
    },
    resolvedDeps,
    {
      commitTemplate: templates.commitTemplate,
      prTemplate: templates.prTemplate,
    },
    config.ai.provider,
  );
  let commitMessage = generated.commitMessage;
  let prDescription = generated.prDescription;

  const renderer = resolvedDeps.createTerminalRenderer(
    output,
  ) as TerminalRendererLike;
  renderFlowPreview(renderer, {
    branch: generated.branch,
    commitMessage,
    prDescription,
  });

  if (options.dryRun) {
    return {
      branch: generated.branch,
      commitMessage,
      prDescription,
      dryRun: true,
      aborted: false,
    };
  }

  if (!options.yes) {
    const approval = await resolvedDeps.promptApproval();
    if (approval === 'cancel') {
      return {
        branch: generated.branch,
        commitMessage,
        prDescription,
        dryRun: false,
        aborted: true,
      };
    }
    if (approval === 'edit') {
      const edited = await resolvedDeps.editGeneratedContent(cwd, {
        commitMessage,
        prDescription,
      });
      commitMessage = edited.commitMessage.trim();
      prDescription = edited.prDescription.trim();
      renderFlowPreview(renderer, {
        branch: generated.branch,
        commitMessage,
        prDescription,
      });
    }
  }

  await resolvedDeps.create(generated.branch, cwd, { noAi: true });
  await withTempMarkdownFile(
    'commit-message',
    commitMessage,
    async (filePath) => resolvedDeps.commitStagedFromFile(filePath, cwd),
  );

  const submitted = await resolvedDeps.submit(cwd, false, {
    path: 'current',
    fix: false,
    summaryOverrides: new Map([[generated.branch, prDescription]]),
  });

  return {
    branch: generated.branch,
    commitMessage,
    prDescription,
    dryRun: false,
    aborted: false,
    submitted,
  };
}

function validateStageMode(options: FlowOptions): void {
  const activeModes = [options.all, options.update, options.patch].filter(
    Boolean,
  );
  if (activeModes.length > 1) {
    throw new DubError(
      "Choose only one staging mode: '--all', '--update', or '--patch'.",
    );
  }
}

async function stageChanges(
  cwd: string,
  options: FlowOptions,
  deps: FlowDependencies,
): Promise<void> {
  if (options.patch) {
    await deps.interactiveStage(cwd);
    return;
  }
  if (options.all) {
    await deps.stageAll(cwd);
    return;
  }
  if (options.update) {
    await deps.stageUpdate(cwd);
  }
}

function renderFlowPreview(
  renderer: TerminalRendererLike,
  content: {
    branch: string;
    commitMessage: string;
    prDescription: string;
  },
): void {
  renderer.renderPreview('Branch Name', content.branch);
  renderer.renderPreview(
    'Commit Message',
    ['```text', content.commitMessage, '```'].join('\n'),
  );
  renderer.renderPreview('PR Description', content.prDescription);
  renderer.renderPreview(
    'Planned Commands',
    [
      '```bash',
      `dub create ${content.branch}`,
      'git commit --file <temp-commit-message.md>',
      'dub submit',
      '```',
    ].join('\n'),
  );
}

async function promptApprovalChoice(): Promise<ApprovalChoice> {
  if (!(process.stdout.isTTY && process.stdin.isTTY)) {
    throw new DubError(
      "Flow requires confirmation in an interactive terminal. Re-run with '-y' to auto-approve.",
    );
  }

  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question('[Y]es  [E]dit  [C]ancel: ');
    const normalized = answer.trim().toLowerCase();
    if (normalized === 'e' || normalized === 'edit') return 'edit';
    if (normalized === 'c' || normalized === 'cancel' || normalized === 'n') {
      return 'cancel';
    }
    return 'approve';
  } finally {
    rl.close();
  }
}

async function editGeneratedContent(
  cwd: string,
  content: { commitMessage: string; prDescription: string },
): Promise<{ commitMessage: string; prDescription: string }> {
  const commitFile = writeTempMarkdownFile(
    'commit-message',
    content.commitMessage,
  );
  const prFile = writeTempMarkdownFile('pr-description', content.prDescription);

  try {
    await openEditor(commitFile, cwd);
    await openEditor(prFile, cwd);

    return {
      commitMessage: fs.readFileSync(commitFile, 'utf8').trim(),
      prDescription: fs.readFileSync(prFile, 'utf8').trim(),
    };
  } finally {
    removeTempFile(commitFile);
    removeTempFile(prFile);
  }
}

async function openEditor(filePath: string, cwd: string): Promise<void> {
  const editor =
    process.env.VISUAL?.trim() || process.env.EDITOR?.trim() || 'vi';
  await execa(editor, [filePath], {
    cwd,
    stdio: 'inherit',
  });
}
