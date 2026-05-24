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
  buildMetadataTree,
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

/** @deprecated Use SubmitScope. Retained for the v1 `--path` deprecation window. */
export type SubmitPathMode = 'current' | 'stack';

/** Scope of branches submit/get-plan operates over. */
export type SubmitScope =
  | { kind: 'downstack' }
  | { kind: 'upstack' }
  | { kind: 'stack' }
  | { kind: 'branch'; branch: string };

export interface SubmitOptions {
  ai?: boolean;
  noAi?: boolean;
  /** @deprecated Use upstack/downstack/stack/branch. Emits a deprecation warning. */
  path?: SubmitPathMode;
  upstack?: boolean;
  downstack?: boolean;
  stack?: boolean;
  branch?: string;
  fix?: boolean;
  summaryOverrides?: Map<string, string>;
}

export interface SubmitPlan {
  state: DubState;
  stack: Stack;
  currentBranch: string;
  rootBranch: string;
  scope: SubmitScope;
  branches: Branch[];
}

export interface SubmitResult {
  pushed: string[];
  created: string[];
  updated: string[];
  scope: SubmitScope;
  dryRun: boolean;
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
 * @throws {DubError} If not in a stack, on root branch, or gh errors
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

  if (options.fix) {
    console.log(
      "⚠ '--fix' is deprecated and is now a no-op; submit handles branching stacks natively.",
    );
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

  const scopeLabel = describeScope(plan.scope, plan.currentBranch);
  console.log(
    `Submitting ${plan.branches.length} branch(es) in ${scopeLabel} onto trunk '${plan.rootBranch}'.`,
  );
  if (dryRun) {
    console.log('[dry-run] no branches will be pushed or mutated.');
  }

  const result: SubmitResult = {
    pushed: [],
    created: [],
    updated: [],
    scope: plan.scope,
    dryRun,
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
      await updateAllPrBodies(
        plan.branches,
        plan.stack.branches,
        prMap,
        plan.stack.id,
        cwd,
        {
          useAi,
          deps,
          summaryOverrides: options.summaryOverrides,
          prTemplate: templates?.prTemplate ?? null,
          providerConfig: config.ai.provider,
        },
      );

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
  const scope = resolveScope(options);
  const state = await readState(cwd);
  const currentBranch = await getCurrentBranch(cwd);

  // For --branch <name>, resolve the stack containing that branch instead of
  // requiring the current branch to be tracked.
  const targetBranch = scope.kind === 'branch' ? scope.branch : currentBranch;
  const stack = findStackForBranch(state, targetBranch);

  if (!stack) {
    if (scope.kind === 'branch') {
      throw new DubError(
        `Branch '${scope.branch}' is not part of any tracked stack.`,
        [
          `Run 'dub track ${scope.branch} --parent <branch>' to track it.`,
          "Run 'dub log' to list tracked branches.",
        ],
      );
    }
    throw new DubError(`Branch '${currentBranch}' is not part of any stack.`, [
      "Run 'dub create <branch>' to start a stack from this branch.",
      "Run 'dub track <branch>' to track this branch on a parent.",
      "Run 'dub checkout <branch>' to switch to a tracked branch.",
    ]);
  }

  const ordered = topologicalOrder(stack);
  const targetEntry = ordered.find((b) => b.name === targetBranch);
  if (targetEntry?.type === 'root') {
    if (scope.kind === 'branch') {
      throw new DubError(`Cannot submit root branch '${scope.branch}'.`, [
        'Choose a non-root tracked branch name.',
      ]);
    }
    throw new DubError('Cannot submit from a root branch.', [
      "Run 'dub up' to move to the next branch above this trunk.",
      "Run 'dub checkout <branch>' to switch to a stacked branch.",
    ]);
  }

  const branchesWithRoot = selectScopedBranches(
    stack,
    ordered,
    scope,
    targetBranch,
  );

  const rootBranch =
    ordered.find((branch) => branch.type === 'root' || !branch.parent)?.name ??
    '(unknown)';
  const branches = branchesWithRoot.filter((b) => b.type !== 'root');

  return {
    state,
    stack,
    currentBranch,
    rootBranch,
    scope,
    branches,
  };
}

/**
 * Validates flag mutual exclusion and resolves SubmitOptions into a SubmitScope.
 * Emits a deprecation warning for the legacy `--path` flag.
 */
export function resolveScope(options: SubmitOptions): SubmitScope {
  const flags: Array<{ name: string; set: boolean }> = [
    { name: '--upstack', set: options.upstack === true },
    { name: '--downstack', set: options.downstack === true },
    { name: '--stack', set: options.stack === true },
    { name: '--branch', set: options.branch != null },
    { name: '--path', set: options.path != null },
  ];
  const activeFlags = flags.filter((f) => f.set).map((f) => f.name);
  if (activeFlags.length > 1) {
    const recovery = [
      'Pass exactly one of --upstack, --downstack, --stack, --branch <name>.',
      'Omit all scope flags to submit the current branch and its ancestors (default).',
    ];
    if (activeFlags.includes('--path')) {
      recovery.push(
        "Drop '--path' — it is deprecated and cannot be combined with the new scope flags.",
      );
    }
    throw new DubError(
      `Scope flags are mutually exclusive: ${activeFlags.join(', ')}.`,
      recovery,
    );
  }

  if (options.path != null) {
    if (options.path === 'current') {
      console.warn(
        "⚠ '--path current' is deprecated. Use '--downstack' instead. This will stop working in v2.",
      );
      return { kind: 'downstack' };
    }
    if (options.path === 'stack') {
      console.warn(
        "⚠ '--path stack' is deprecated. Use '--stack' instead. This will stop working in v2.",
      );
      return { kind: 'stack' };
    }
  }

  if (options.upstack) return { kind: 'upstack' };
  if (options.stack) return { kind: 'stack' };
  if (options.branch != null) return { kind: 'branch', branch: options.branch };
  // Default and explicit --downstack both map to downstack.
  return { kind: 'downstack' };
}

function selectScopedBranches(
  stack: Stack,
  ordered: Branch[],
  scope: SubmitScope,
  targetBranch: string,
): Branch[] {
  if (scope.kind === 'stack') return ordered;
  if (scope.kind === 'branch') {
    const entry = stack.branches.find((b) => b.name === scope.branch);
    return entry ? [entry] : [];
  }
  if (scope.kind === 'upstack') {
    return getUpstackBranches(stack, targetBranch);
  }
  return getDownstackBranches(stack, targetBranch);
}

function getUpstackBranches(stack: Stack, startBranch: string): Branch[] {
  const childMap = new Map<string, Branch[]>();
  for (const branch of stack.branches) {
    if (branch.parent) {
      const list = childMap.get(branch.parent) ?? [];
      list.push(branch);
      childMap.set(branch.parent, list);
    }
  }
  for (const children of childMap.values()) {
    children.sort((a, b) => a.name.localeCompare(b.name));
  }

  const start = stack.branches.find((b) => b.name === startBranch);
  if (!start) return [];
  const result: Branch[] = [];
  const queue: Branch[] = [start];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    if (seen.has(current.name)) {
      throw new DubError(
        `Stack metadata is invalid: cycle detected while walking upstack from '${startBranch}'.`,
        [
          "Run 'dub doctor' to inspect the stack and surface the bad parent link.",
          "Run 'dub track <branch> --parent <branch>' to re-parent the affected branch.",
        ],
      );
    }
    seen.add(current.name);
    result.push(current);
    const children = childMap.get(current.name) ?? [];
    queue.push(...children);
  }
  return result;
}

function getDownstackBranches(stack: Stack, currentBranch: string): Branch[] {
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

function describeScope(scope: SubmitScope, currentBranch: string): string {
  switch (scope.kind) {
    case 'stack':
      return `the stack containing '${currentBranch}'`;
    case 'upstack':
      return `the upstack from '${currentBranch}'`;
    case 'branch':
      return `branch '${scope.branch}'`;
    case 'downstack':
      return `the downstack from '${currentBranch}'`;
  }
}

async function updateAllPrBodies(
  branches: Branch[],
  stackBranches: Branch[],
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
  // Build the PR table from both this run's prMap AND any PR numbers persisted
  // in state for other branches in the stack — so siblings submitted in prior
  // runs still appear with their PR numbers in the tree table.
  //
  // For prior-run branches we don't have the PR title cached locally, so the
  // branch name is used as the table label. That matches the issue spec's
  // target example (which labels rows like `feat/auth-base` rather than a
  // free-form title) and keeps submit free of extra GitHub API calls.
  const tableEntries = new Map<string, { number: number; title: string }>();
  for (const branch of stackBranches) {
    const pr = prMap.get(branch.name);
    if (pr) {
      tableEntries.set(branch.name, { number: pr.number, title: pr.title });
    } else if (branch.pr_number != null) {
      tableEntries.set(branch.name, {
        number: branch.pr_number,
        title: branch.name,
      });
    }
  }

  const childrenByParent = new Map<string, Branch[]>();
  for (const branch of stackBranches) {
    if (branch.parent != null) {
      const arr = childrenByParent.get(branch.parent) ?? [];
      arr.push(branch);
      childrenByParent.set(branch.parent, arr);
    }
  }
  for (const branch of branches) {
    const pr = prMap.get(branch.name);
    if (!pr) continue;

    const parentName = branch.parent;
    const parentEntry = parentName ? tableEntries.get(parentName) : null;
    const prevPr = parentEntry?.number ?? null;

    const childBranches = (childrenByParent.get(branch.name) ?? [])
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
    // next_pr only makes sense for a linear (single-child) continuation.
    const nextPr =
      childBranches.length === 1
        ? (tableEntries.get(childBranches[0].name)?.number ?? null)
        : null;

    const directChildren = childBranches.map((c) => c.name);
    const siblings = parentName
      ? (childrenByParent.get(parentName) ?? [])
          .filter((c) => c.name !== branch.name)
          .map((c) => c.name)
          .sort((a, b) => a.localeCompare(b))
      : [];

    const stackTable = buildStackTable(
      stackBranches,
      tableEntries,
      branch.name,
    );
    const metadataBlock = buildMetadataBlock({
      schema_version: 1,
      stack_id: stackId,
      pr_number: pr.number,
      branch: branch.name,
      parent: parentName ?? null,
      children: directChildren,
      siblings,
      prev_pr: prevPr,
      next_pr: nextPr,
      tree: buildMetadataTree(stackBranches, tableEntries, branch.name),
    });

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
