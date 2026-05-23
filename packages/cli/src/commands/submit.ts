import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { fromIni, fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { createGateway, generateText } from 'ai';
import {
  type AiMetadataDependencies,
  generatePrDescriptionSummary,
} from '../lib/ai-metadata';
import { readConfig } from '../lib/config';
import { DubError } from '../lib/errors';
import {
  getBranchTip,
  getCurrentBranch,
  getDiffBetween,
  getLastCommitMessage,
  pushBranch,
} from '../lib/git';
import {
  checkGhAuth,
  createPr,
  ensureGhInstalled,
  getPr,
  type PrInfo,
  updatePrBody,
} from '../lib/github';
import { readMetadataTemplates } from '../lib/metadata-templates';
import {
  buildMetadataBlock,
  buildStackTable,
  composePrBody,
} from '../lib/pr-body';
import { createProgress } from '../lib/progress';
import {
  type Branch,
  type DubState,
  findStackForBranch,
  readState,
  type Stack,
  topologicalOrder,
  writeState,
} from '../lib/state';
import { withTempMarkdownFile } from '../lib/temp-text-file';

export type SubmitPathMode = 'current' | 'stack';

interface SubmitBranchingBlocker {
  parent: string;
  children: string[];
}

export interface SubmitOptions {
  ai?: boolean;
  noAi?: boolean;
  path?: SubmitPathMode;
  fix?: boolean;
  summaryOverrides?: Map<string, string>;
}

export interface SubmitPlan {
  state: DubState;
  stack: Stack;
  currentBranch: string;
  rootBranch: string;
  path: SubmitPathMode;
  branches: Branch[];
  fallbackApplied: boolean;
}

export interface SubmitResult {
  pushed: string[];
  created: string[];
  updated: string[];
  path: SubmitPathMode;
  dryRun: boolean;
  fallbackApplied: boolean;
}

type SubmitDependencies = AiMetadataDependencies;

const DEFAULT_DEPS: SubmitDependencies = {
  generateText,
  createGoogleGenerativeAI,
  createGateway,
  createAmazonBedrock,
  fromIni,
  fromNodeProviderChain,
};

/**
 * Pushes branches in the current stack and creates/updates GitHub PRs.
 *
 * @param cwd - Working directory
 * @param dryRun - If true, prints what would happen without executing
 * @throws {DubError} If not in a stack, on root branch, stack is non-linear, or gh errors
 */
export async function submit(
  cwd: string,
  dryRun: boolean,
  options: SubmitOptions = {},
  deps: SubmitDependencies = DEFAULT_DEPS,
): Promise<SubmitResult> {
  if (options.ai && options.noAi) {
    throw new DubError("'--ai' cannot be combined with '--no-ai'.", [
      "Pass '--ai' alone to force AI-generated PR descriptions.",
      "Pass '--no-ai' alone to skip AI generation for this run.",
    ]);
  }

  const plan = await getSubmitPlan(cwd, options);
  const config = await readConfig(cwd);
  const useAi =
    options.ai === true
      ? true
      : options.noAi === true
        ? false
        : config.ai.defaults.submitDescription;

  if (useAi && !config.aiAssistantEnabled) {
    throw new DubError('AI assistant is disabled for this repo.', [
      "Run 'dub config ai-assistant on' to enable AI for this repo.",
      "Rerun 'dub submit --no-ai' to submit without AI for this run.",
    ]);
  }
  const templates = useAi ? await readMetadataTemplates(cwd) : null;

  await ensureGhInstalled();
  await checkGhAuth();

  console.log(
    `Submitting ${plan.branches.length} branch(es) from '${plan.currentBranch}' onto trunk '${plan.rootBranch}'.`,
  );
  if (plan.fallbackApplied) {
    console.log(
      "⚠ Submit --fix detected branching in '--path stack' mode; using '--path current' for this run.",
    );
  }
  if (dryRun) {
    console.log('[dry-run] no branches will be pushed or mutated.');
  }

  const result: SubmitResult = {
    pushed: [],
    created: [],
    updated: [],
    path: plan.path,
    dryRun,
    fallbackApplied: plan.fallbackApplied,
  };
  const prMap = new Map<string, PrInfo>();
  const progress = createProgress();

  try {
    if (!dryRun && plan.branches.length > 0) {
      progress.start('🚀 Pushing branches', plan.branches.length);
    }
    let pushIndex = 0;
    for (const branch of plan.branches) {
      if (dryRun) {
        console.log(`[dry-run] would push ${branch.name}`);
      } else {
        pushIndex += 1;
        progress.update('🚀 Pushing branches', pushIndex, branch.name);
        await pushBranch(branch.name, cwd);
      }
      result.pushed.push(branch.name);
    }
    if (!dryRun && plan.branches.length > 0) {
      progress.complete('🚀 Pushing branches');
    }

    if (!dryRun && plan.branches.length > 0) {
      progress.start('📬 Syncing PRs', plan.branches.length);
    }
    let prIndex = 0;
    for (const branch of plan.branches) {
      const base = branch.parent as string;

      if (dryRun) {
        console.log(
          `[dry-run] would check/create PR: ${branch.name} → ${base}`,
        );
        continue;
      }
      prIndex += 1;
      progress.update('📬 Syncing PRs', prIndex, branch.name);

      const existing = await getPr(branch.name, cwd);
      if (existing) {
        prMap.set(branch.name, existing);
        result.updated.push(branch.name);
      } else {
        const title = await getLastCommitMessage(branch.name, cwd);
        const created = await withTempMarkdownFile(
          'pr-body',
          '',
          async (tmpFile) => {
            return createPr(branch.name, base, title, tmpFile, cwd);
          },
        );
        prMap.set(branch.name, created);
        result.created.push(branch.name);
      }
    }
    if (!dryRun && plan.branches.length > 0) {
      progress.complete('📬 Syncing PRs');
    }

    if (!dryRun) {
      await updateAllPrBodies(plan.branches, prMap, plan.stack.id, cwd, {
        useAi,
        deps,
        summaryOverrides: options.summaryOverrides,
        prTemplate: templates?.prTemplate ?? null,
        providerConfig: config.ai.provider,
      });

      for (const branch of plan.branches) {
        const pr = prMap.get(branch.name);
        if (pr) {
          const stateBranch = plan.stack.branches.find(
            (b) => b.name === branch.name,
          );
          if (stateBranch) {
            stateBranch.pr_number = pr.number;
            stateBranch.pr_link = pr.url;
            const headSha = await getBranchTip(branch.name, cwd);
            const baseSha = await getBranchTip(branch.parent as string, cwd);
            stateBranch.last_submitted_version = {
              head_sha: headSha,
              base_sha: baseSha,
              base_branch: branch.parent as string,
              version_number: null,
              source: 'submit',
            };
            stateBranch.last_reconciled_version = {
              head_sha: headSha,
              base_sha: baseSha,
              base_branch: branch.parent as string,
              source: 'submit',
            };
            if (stateBranch.parent_revision == null) {
              stateBranch.parent_revision = baseSha;
            }
            stateBranch.last_synced_at = new Date().toISOString();
            stateBranch.sync_source = 'submit';
          }
        }
      }
      await writeState(plan.state, cwd);
    }

    return result;
  } finally {
    progress.stop();
  }
}

export async function getSubmitPlan(
  cwd: string,
  options: SubmitOptions = {},
): Promise<SubmitPlan> {
  const state = await readState(cwd);
  const currentBranch = await getCurrentBranch(cwd);
  const stack = findStackForBranch(state, currentBranch);

  if (!stack) {
    throw new DubError(`Branch '${currentBranch}' is not part of any stack.`, [
      "Run 'dub create <branch>' to start a stack from this branch.",
      "Run 'dub track <branch>' to track this branch on a parent.",
      "Run 'dub checkout <branch>' to switch to a tracked branch.",
    ]);
  }

  const ordered = topologicalOrder(stack);
  const currentEntry = ordered.find((b) => b.name === currentBranch);
  if (currentEntry?.type === 'root') {
    throw new DubError('Cannot submit from a root branch.', [
      "Run 'dub up' to move to the next branch above this trunk.",
      "Run 'dub checkout <branch>' to switch to a stacked branch.",
    ]);
  }

  const requestedPath = options.path ?? 'current';
  let resolvedPath: SubmitPathMode = requestedPath;
  let branchesWithRoot =
    requestedPath === 'stack'
      ? ordered
      : getCurrentPathBranches(stack, currentBranch);
  let fallbackApplied = false;
  let blockers = findBranchingBlockers(branchesWithRoot);

  if (blockers.length > 0 && requestedPath === 'stack' && options.fix) {
    const currentPathBranches = getCurrentPathBranches(stack, currentBranch);
    const currentPathBlockers = findBranchingBlockers(currentPathBranches);
    if (currentPathBlockers.length === 0) {
      resolvedPath = 'current';
      branchesWithRoot = currentPathBranches;
      blockers = [];
      fallbackApplied = true;
    }
  }

  if (blockers.length > 0) {
    const { message, recovery } = buildBranchingError(blockers, currentBranch);
    throw new DubError(message, recovery);
  }

  const rootBranch =
    branchesWithRoot.find((branch) => branch.type === 'root' || !branch.parent)
      ?.name ?? '(unknown)';
  const branches = branchesWithRoot.filter((b) => b.type !== 'root');

  return {
    state,
    stack,
    currentBranch,
    rootBranch,
    path: resolvedPath,
    branches,
    fallbackApplied,
  };
}

function getCurrentPathBranches(stack: Stack, currentBranch: string): Branch[] {
  const branchMap = new Map(
    stack.branches.map((branch) => [branch.name, branch]),
  );
  const path: Branch[] = [];
  const seen = new Set<string>();
  let cursor = branchMap.get(currentBranch);

  if (!cursor) {
    throw new DubError(`Branch '${currentBranch}' is not part of any stack.`, [
      "Run 'dub create <branch>' to start a stack from this branch.",
      "Run 'dub track <branch>' to track this branch on a parent.",
    ]);
  }

  while (cursor) {
    if (seen.has(cursor.name)) {
      throw new DubError(
        `Stack metadata is invalid: cycle detected while tracing '${currentBranch}'.`,
        [
          "Run 'dub doctor' to inspect the stack and surface the bad parent link.",
          "Run 'dub track <branch> --parent <branch>' to re-parent the affected branch.",
        ],
      );
    }
    seen.add(cursor.name);
    path.push(cursor);
    if (!cursor.parent) break;
    cursor = branchMap.get(cursor.parent);
    if (!cursor) {
      throw new DubError(
        `Stack metadata is invalid: missing parent branch while tracing '${currentBranch}'.`,
        [
          "Run 'dub doctor' to identify the missing parent.",
          "Run 'dub track <branch> --parent <branch>' to re-parent the affected branch onto a known parent.",
        ],
      );
    }
  }

  return path.reverse();
}

function findBranchingBlockers(ordered: Branch[]): SubmitBranchingBlocker[] {
  const branchSet = new Set(ordered.map((branch) => branch.name));
  const childMap = new Map<string, string[]>();

  for (const branch of ordered) {
    if (!branch.parent || !branchSet.has(branch.parent)) continue;
    const children = childMap.get(branch.parent) ?? [];
    children.push(branch.name);
    childMap.set(branch.parent, children);
  }

  const blockers: SubmitBranchingBlocker[] = [];
  for (const [parent, children] of childMap) {
    if (children.length <= 1) continue;
    blockers.push({
      parent,
      children: [...children].sort(),
    });
  }

  return blockers.sort((a, b) => a.parent.localeCompare(b.parent));
}

function buildBranchingError(
  blockers: SubmitBranchingBlocker[],
  currentBranch: string,
): { message: string; recovery: string[] } {
  const details = blockers
    .map((blocker) => `${blocker.parent} -> ${blocker.children.join(', ')}`)
    .join('\n  - ');
  const message =
    'Branching stacks are not supported by submit in this mode.\n' +
    `Found ${blockers.length} branching parent(s):\n` +
    `  - ${details}\n` +
    `Current branch: '${currentBranch}'`;
  return {
    message,
    recovery: [
      "Run 'dub submit --path current' to submit only your current linear path.",
      "Run 'dub submit --path stack --fix' to retry with safe auto-fix.",
      "Run 'dub track <child> --parent <branch>' to re-parent and linearize manually.",
    ],
  };
}

async function updateAllPrBodies(
  branches: Branch[],
  prMap: Map<string, PrInfo>,
  stackId: string,
  cwd: string,
  options: {
    useAi: boolean;
    deps: SubmitDependencies;
    summaryOverrides?: Map<string, string>;
    prTemplate: string | null;
    providerConfig: NonNullable<
      Awaited<ReturnType<typeof readConfig>>['ai']
    >['provider'];
  },
): Promise<void> {
  const tableEntries = new Map<string, { number: number; title: string }>();
  for (const branch of branches) {
    const pr = prMap.get(branch.name);
    if (pr) {
      tableEntries.set(branch.name, { number: pr.number, title: pr.title });
    }
  }

  for (let i = 0; i < branches.length; i++) {
    const branch = branches[i];
    const pr = prMap.get(branch.name);
    if (!pr) continue;

    const prevPr =
      i > 0 ? (prMap.get(branches[i - 1].name)?.number ?? null) : null;
    const nextPr =
      i < branches.length - 1
        ? (prMap.get(branches[i + 1].name)?.number ?? null)
        : null;

    const stackTable = buildStackTable(branches, tableEntries, branch.name);
    const metadataBlock = buildMetadataBlock(
      stackId,
      pr.number,
      prevPr,
      nextPr,
      branch.name,
    );

    const existingBody = pr.body;
    const aiSummaryOverride = options.summaryOverrides?.get(branch.name);
    const aiSummary =
      typeof aiSummaryOverride === 'string'
        ? aiSummaryOverride
        : options.useAi
          ? await generatePrDescriptionSummary(
              {
                branch: branch.name,
                baseBranch: branch.parent as string,
                commitMessage: await getLastCommitMessage(branch.name, cwd),
                diff: await getDiffForPrDescription(
                  branch.name,
                  branch.parent as string,
                  cwd,
                ),
              },
              options.deps,
              {
                prTemplate: options.prTemplate,
              },
              options.providerConfig,
            )
          : '';
    const finalBody = composePrBody(
      existingBody,
      aiSummary,
      stackTable,
      metadataBlock,
    );

    await withTempMarkdownFile('pr-body', finalBody, async (tmpFile) => {
      await updatePrBody(pr.number, tmpFile, cwd);
    });
  }
}

async function getDiffForPrDescription(
  branchName: string,
  baseBranch: string,
  cwd: string,
): Promise<string> {
  try {
    return await getDiffBetween(baseBranch, branchName, cwd);
  } catch {
    throw new DubError(
      `Failed to generate an AI PR summary for '${branchName}' because its diff could not be loaded.`,
      [
        `Run 'git fetch origin ${branchName}' to ensure the branch and its parent are present locally.`,
        "Rerun 'dub submit --no-ai' to submit without an AI-generated description.",
      ],
    );
  }
}
