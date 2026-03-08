import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DubError } from '../lib/errors';
import {
  getBranchTip,
  getCurrentBranch,
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
import {
  buildMetadataBlock,
  buildStackTable,
  composePrBody,
} from '../lib/pr-body';
import {
  type Branch,
  type DubState,
  findStackForBranch,
  readState,
  type Stack,
  topologicalOrder,
  writeState,
} from '../lib/state';

export type SubmitPathMode = 'current' | 'stack';

interface SubmitBranchingBlocker {
  parent: string;
  children: string[];
}

export interface SubmitOptions {
  path?: SubmitPathMode;
  fix?: boolean;
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
): Promise<SubmitResult> {
  const plan = await getSubmitPlan(cwd, options);

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

  for (const branch of plan.branches) {
    if (dryRun) {
      console.log(`[dry-run] would push ${branch.name}`);
    } else {
      await pushBranch(branch.name, cwd);
    }
    result.pushed.push(branch.name);
  }

  for (const branch of plan.branches) {
    const base = branch.parent as string;

    if (dryRun) {
      console.log(`[dry-run] would check/create PR: ${branch.name} → ${base}`);
      continue;
    }

    const existing = await getPr(branch.name, cwd);
    if (existing) {
      prMap.set(branch.name, existing);
      result.updated.push(branch.name);
    } else {
      const title = await getLastCommitMessage(branch.name, cwd);
      const tmpFile = writeTempBody('');
      try {
        const created = await createPr(branch.name, base, title, tmpFile, cwd);
        prMap.set(branch.name, created);
        result.created.push(branch.name);
      } finally {
        cleanupTempFile(tmpFile);
      }
    }
  }

  if (!dryRun) {
    await updateAllPrBodies(plan.branches, prMap, plan.stack.id, cwd);

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
}

export async function getSubmitPlan(
  cwd: string,
  options: SubmitOptions = {},
): Promise<SubmitPlan> {
  const state = await readState(cwd);
  const currentBranch = await getCurrentBranch(cwd);
  const stack = findStackForBranch(state, currentBranch);

  if (!stack) {
    throw new DubError(
      `Branch '${currentBranch}' is not part of any stack. Run 'dub create' first.`,
    );
  }

  const ordered = topologicalOrder(stack);
  const currentEntry = ordered.find((b) => b.name === currentBranch);
  if (currentEntry?.type === 'root') {
    throw new DubError(
      "Cannot submit from a root branch. Run 'dub up' or 'dub checkout <branch>' first.",
    );
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
    throw new DubError(buildBranchingErrorMessage(blockers, currentBranch));
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
    throw new DubError(
      `Branch '${currentBranch}' is not part of any stack. Run 'dub create' first.`,
    );
  }

  while (cursor) {
    if (seen.has(cursor.name)) {
      throw new DubError(
        `Stack metadata is invalid: cycle detected while tracing '${currentBranch}'.`,
      );
    }
    seen.add(cursor.name);
    path.push(cursor);
    if (!cursor.parent) break;
    cursor = branchMap.get(cursor.parent);
    if (!cursor) {
      throw new DubError(
        `Stack metadata is invalid: missing parent branch while tracing '${currentBranch}'.`,
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

function buildBranchingErrorMessage(
  blockers: SubmitBranchingBlocker[],
  currentBranch: string,
): string {
  const details = blockers
    .map((blocker) => `${blocker.parent} -> ${blocker.children.join(', ')}`)
    .join('\n  - ');
  return (
    'Branching stacks are not supported by submit in this mode.\n' +
    `Found ${blockers.length} branching parent(s):\n` +
    `  - ${details}\n` +
    `Current branch: '${currentBranch}'\n` +
    'Fix options:\n' +
    '  1. Submit only your current linear path: dub submit --path current\n' +
    '  2. Retry with safe auto-fix: dub submit --path stack --fix\n' +
    '  3. Re-parent to linearize manually: dub track <child> --parent <branch>'
  );
}

async function updateAllPrBodies(
  branches: Branch[],
  prMap: Map<string, PrInfo>,
  stackId: string,
  cwd: string,
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
    const finalBody = composePrBody(existingBody, stackTable, metadataBlock);

    const tmpFile = writeTempBody(finalBody);
    try {
      await updatePrBody(pr.number, tmpFile, cwd);
    } finally {
      cleanupTempFile(tmpFile);
    }
  }
}

function writeTempBody(content: string): string {
  const tmpDir = os.tmpdir();
  const tmpFile = path.join(tmpDir, `dubstack-body-${Date.now()}.md`);
  fs.writeFileSync(tmpFile, content);
  return tmpFile;
}

function cleanupTempFile(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Best-effort cleanup
  }
}
