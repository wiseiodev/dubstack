import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { fromIni, fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { createGateway, generateText } from 'ai';
import { execa } from 'execa';
import { resolveAiProvider } from '../lib/ai-provider';
import { readConfig } from '../lib/config';
import { DubError } from '../lib/errors';
import {
  getBranchTip,
  getCurrentBranch,
  getMergeBase,
  isWorkingTreeClean,
  rebaseAbort,
  rebaseContinue,
} from '../lib/git';
import { hasGitRebaseInProgress } from '../lib/operation-state';
import { createProgress } from '../lib/progress';
import {
  type DubState,
  findStackForBranch,
  getDubDir,
  readState,
  type Stack,
  topologicalOrder,
} from '../lib/state';
import { saveUndoEntry } from '../lib/undo-log';
import { assertBranchesNotCheckedOutElsewhere } from '../lib/worktree-guards';
import { restack } from './restack';

export type AbsorbMode = 'auto' | 'ai' | 'stack';

export interface AbsorbOptions {
  ai?: boolean;
  stack?: boolean;
  dryRun?: boolean;
  interactive?: boolean;
  quiet?: boolean;
}

export interface AbsorbDependencies {
  generateText: typeof generateText;
  createGoogleGenerativeAI: typeof createGoogleGenerativeAI;
  createAnthropic?: typeof createAnthropic;
  createGateway: typeof createGateway;
  createAmazonBedrock?: typeof createAmazonBedrock;
  createOpenAI?: typeof createOpenAI;
  createOpenAICompatible?: typeof createOpenAICompatible;
  fromIni?: typeof fromIni;
  fromNodeProviderChain?: typeof fromNodeProviderChain;
  readConfig: typeof readConfig;
}

const DEFAULT_DEPS: AbsorbDependencies = {
  generateText,
  createGoogleGenerativeAI,
  createAnthropic,
  createGateway,
  createAmazonBedrock,
  createOpenAI,
  createOpenAICompatible,
  fromIni,
  fromNodeProviderChain,
  readConfig,
};

interface CommitInfo {
  sha: string;
  shortSha: string;
  subject: string;
  files: string[];
}

interface AbsorbProgress {
  mode: AbsorbMode;
  originalBranch: string;
  rebaseBranch: string;
  needsRestack: boolean;
}

export interface AbsorbResult {
  mode: AbsorbMode;
  branch: string;
  /** Number of commits that were absorbed into earlier commits. */
  absorbed: number;
  /** Commits the AI mode classified as WIP but could not assign a target. */
  skipped: number;
  /** Branches the cross-branch mode moved commits onto. */
  movedTo: string[];
  /** Branches that were rebased by the auto-restack step. */
  restacked: string[];
  /** True when the rebase paused on a conflict; user must `dub continue`. */
  conflict: boolean;
  /** True when invoked with `--dry-run`; no mutations were performed. */
  dryRun: boolean;
}

const WIP_SUBJECT_RE = /^(wip\b|fix\b|tmp\b|tweak\b|address|feedback)/i;
const CONVENTIONAL_COMMIT_RE =
  /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]+\))?!?:\s.+/i;
const FIXUP_PREFIX_RE = /^(fixup|squash|amend)!\s+(.+)$/;

/**
 * Distributes fixup-style commits to their targets.
 *
 * Three modes:
 * - default (no flag): run `git rebase --autosquash` for literal `fixup!` /
 *   `squash!` prefixes on the current branch.
 * - `--ai`: ask the configured AI provider to pick targets for WIP-style
 *   commits whose target is ambiguous from the commit subject alone.
 * - `--stack`: walk every branch in the current stack and move fixup commits
 *   whose target lives on a *different* branch, then restack.
 */
export async function absorb(
  cwd: string,
  options: AbsorbOptions = {},
  deps: AbsorbDependencies = DEFAULT_DEPS,
): Promise<AbsorbResult> {
  if (options.ai && options.stack) {
    throw new DubError("'--ai' cannot be combined with '--stack'.", [
      "Run 'dub absorb --ai' to resolve ambiguous WIP commits on the current branch.",
      "Run 'dub absorb --stack' to move cross-branch fixups across the stack.",
    ]);
  }

  if (!(await isWorkingTreeClean(cwd))) {
    throw new DubError('Working tree has uncommitted changes.', [
      "Run 'git status' to see the uncommitted changes.",
      "Run 'git stash' to set the changes aside, then rerun 'dub absorb'.",
      'Run \'dub modify -am "<message>"\' to commit the changes before absorbing.',
    ]);
  }

  const state = await readState(cwd);
  const originalBranch = await getCurrentBranch(cwd);
  const stack = findStackForBranch(state, originalBranch);
  if (!stack) {
    throw new DubError(`Branch '${originalBranch}' is not part of any stack.`, [
      "Run 'dub track <branch>' to track this branch on a parent.",
      "Run 'dub log' to see tracked branches.",
    ]);
  }

  const mode: AbsorbMode = options.stack ? 'stack' : options.ai ? 'ai' : 'auto';

  if (!options.dryRun && mode !== 'stack') {
    await assertBranchesNotCheckedOutElsewhere(
      cwd,
      [originalBranch],
      'dub absorb',
    );
  }

  if (!options.dryRun) {
    await saveUndoEntry(
      {
        operation: 'absorb',
        timestamp: new Date().toISOString(),
        previousBranch: originalBranch,
        previousState: structuredClone(state),
        branchTips: await snapshotStackTips(stack, cwd),
        createdBranches: [],
      },
      cwd,
    );
  }

  if (mode === 'auto') {
    return runAutoMode(cwd, originalBranch, state, stack, options);
  }
  if (mode === 'ai') {
    return runAiMode(cwd, originalBranch, state, stack, options, deps);
  }
  return runStackMode(cwd, originalBranch, state, stack, options);
}

async function runAutoMode(
  cwd: string,
  originalBranch: string,
  state: DubState,
  stack: Stack,
  options: AbsorbOptions,
): Promise<AbsorbResult> {
  const parentBranch = getParentForBranch(stack, originalBranch);
  const base = await resolveAbsorbBase(parentBranch, originalBranch, cwd);
  const commits = await listCommits(base, 'HEAD', cwd);
  const fixupCount = commits.filter((c) =>
    FIXUP_PREFIX_RE.test(c.subject),
  ).length;

  if (fixupCount === 0) {
    return {
      mode: 'auto',
      branch: originalBranch,
      absorbed: 0,
      skipped: 0,
      movedTo: [],
      restacked: [],
      conflict: false,
      dryRun: options.dryRun ?? false,
    };
  }

  if (options.dryRun) {
    return {
      mode: 'auto',
      branch: originalBranch,
      absorbed: fixupCount,
      skipped: 0,
      movedTo: [],
      restacked: [],
      conflict: false,
      dryRun: options.dryRun ?? false,
    };
  }

  await writeAbsorbProgress(cwd, {
    mode: 'auto',
    originalBranch,
    rebaseBranch: originalBranch,
    needsRestack: true,
  });

  try {
    await runAutosquashRebase(base, cwd);
  } catch (error) {
    if (error instanceof DubError && error.message.includes('Conflict')) {
      return {
        mode: 'auto',
        branch: originalBranch,
        absorbed: 0,
        skipped: 0,
        movedTo: [],
        restacked: [],
        conflict: true,
        dryRun: options.dryRun ?? false,
      };
    }
    await clearAbsorbProgress(cwd);
    throw error;
  }

  return finishAbsorbWithRestack(cwd, state, stack, 'auto', {
    branch: originalBranch,
    absorbed: fixupCount,
    skipped: 0,
    movedTo: [],
  });
}

async function runAiMode(
  cwd: string,
  originalBranch: string,
  state: DubState,
  stack: Stack,
  options: AbsorbOptions,
  deps: AbsorbDependencies,
): Promise<AbsorbResult> {
  const parentBranch = getParentForBranch(stack, originalBranch);
  const base = await resolveAbsorbBase(parentBranch, originalBranch, cwd);
  const commits = await listCommits(base, 'HEAD', cwd);
  const wipCommits = commits.filter((c) => isWipCommit(c));

  if (wipCommits.length === 0) {
    return {
      mode: 'ai',
      branch: originalBranch,
      absorbed: 0,
      skipped: 0,
      movedTo: [],
      restacked: [],
      conflict: false,
      dryRun: options.dryRun ?? false,
    };
  }

  const candidates = commits.filter((c) => !wipCommits.includes(c));
  if (candidates.length === 0) {
    throw new DubError(
      `Branch '${originalBranch}' has no non-WIP commits to absorb into.`,
      [
        "Run 'dub absorb' (no flag) to autosquash literal 'fixup!' commits only.",
        "Add at least one Conventional Commit on the branch, then rerun 'dub absorb --ai'.",
      ],
    );
  }

  // Bail before the AI call in dry-run so the preview does not bill against
  // the user's provider. The plan reports the candidate WIP commits as the
  // upper bound on what would be absorbed.
  if (options.dryRun) {
    return {
      mode: 'ai',
      branch: originalBranch,
      absorbed: wipCommits.length,
      skipped: 0,
      movedTo: [],
      restacked: [],
      conflict: false,
      dryRun: true,
    };
  }

  const config = await deps.readConfig(cwd);
  const assignments = await aiPickTargets(
    wipCommits,
    candidates,
    commits,
    deps,
    config.ai.provider,
  );

  const todo = buildCustomRebaseTodo(commits, assignments);
  const assignedCount = assignments.filter((a) => a.targetSha !== null).length;
  const skippedCount = assignments.length - assignedCount;

  if (assignedCount === 0) {
    return {
      mode: 'ai',
      branch: originalBranch,
      absorbed: 0,
      skipped: skippedCount,
      movedTo: [],
      restacked: [],
      conflict: false,
      dryRun: options.dryRun ?? false,
    };
  }

  await writeAbsorbProgress(cwd, {
    mode: 'ai',
    originalBranch,
    rebaseBranch: originalBranch,
    needsRestack: true,
  });

  try {
    await runRebaseWithCustomTodo(base, todo, cwd);
  } catch (error) {
    if (error instanceof DubError && error.message.includes('Conflict')) {
      return {
        mode: 'ai',
        branch: originalBranch,
        absorbed: 0,
        skipped: skippedCount,
        movedTo: [],
        restacked: [],
        conflict: true,
        dryRun: options.dryRun ?? false,
      };
    }
    await clearAbsorbProgress(cwd);
    throw error;
  }

  return finishAbsorbWithRestack(cwd, state, stack, 'ai', {
    branch: originalBranch,
    absorbed: assignedCount,
    skipped: skippedCount,
    movedTo: [],
  });
}

interface CrossFixup {
  sourceBranch: string;
  targetBranch: string;
  fixupSha: string;
  targetSha: string;
  subject: string;
}

async function runStackMode(
  cwd: string,
  originalBranch: string,
  state: DubState,
  stack: Stack,
  options: AbsorbOptions,
): Promise<AbsorbResult> {
  const crossFixups = await collectCrossBranchFixups(stack, cwd);

  if (crossFixups.length === 0) {
    return {
      mode: 'stack',
      branch: originalBranch,
      absorbed: 0,
      skipped: 0,
      movedTo: [],
      restacked: [],
      conflict: false,
      dryRun: options.dryRun ?? false,
    };
  }

  if (options.dryRun) {
    return {
      mode: 'stack',
      branch: originalBranch,
      absorbed: crossFixups.length,
      skipped: 0,
      movedTo: Array.from(new Set(crossFixups.map((f) => f.targetBranch))),
      restacked: [],
      conflict: false,
      dryRun: options.dryRun ?? false,
    };
  }

  await assertBranchesNotCheckedOutElsewhere(
    cwd,
    crossFixups.flatMap((fixup) => [fixup.sourceBranch, fixup.targetBranch]),
    'dub absorb --stack',
  );

  await writeAbsorbProgress(cwd, {
    mode: 'stack',
    originalBranch,
    rebaseBranch: originalBranch,
    needsRestack: true,
  });

  const movedTo = new Set<string>();
  const progress = createProgress();
  progress.start('🥞 Absorbing cross-branch fixups', crossFixups.length);
  let processed = 0;
  try {
    const fixupsByTarget = groupByField(crossFixups, 'targetBranch');
    for (const [targetBranch, fixups] of fixupsByTarget) {
      await execa('git', ['checkout', targetBranch], { cwd });
      for (const fixup of fixups) {
        processed += 1;
        progress.update(
          '🥞 Absorbing cross-branch fixups',
          processed,
          `${fixup.sourceBranch} → ${targetBranch}`,
        );
        await cherryPickOrThrow(fixup, targetBranch, cwd);
      }
      movedTo.add(targetBranch);
    }

    const fixupsBySource = groupByField(crossFixups, 'sourceBranch');
    for (const [sourceBranch, fixups] of fixupsBySource) {
      const parent = getParentForBranch(stack, sourceBranch);
      const base = await resolveAbsorbBase(parent, sourceBranch, cwd);
      await dropCommitsFromBranch(
        sourceBranch,
        base,
        fixups.map((f) => f.fixupSha),
        cwd,
      );
    }

    for (const targetBranch of movedTo) {
      await execa('git', ['checkout', targetBranch], { cwd });
      const parent = getParentForBranch(stack, targetBranch);
      const base = await resolveAbsorbBase(parent, targetBranch, cwd);
      await runAutosquashRebase(base, cwd);
    }

    progress.complete('Absorb complete');
  } catch (error) {
    progress.stop();
    if (error instanceof DubError && error.message.includes('Conflict')) {
      return {
        mode: 'stack',
        branch: originalBranch,
        absorbed: 0,
        skipped: 0,
        movedTo: Array.from(movedTo),
        restacked: [],
        conflict: true,
        dryRun: options.dryRun ?? false,
      };
    }
    await clearAbsorbProgress(cwd);
    throw error;
  }

  await execa('git', ['checkout', originalBranch], { cwd });
  return finishAbsorbWithRestack(cwd, state, stack, 'stack', {
    branch: originalBranch,
    absorbed: crossFixups.length,
    skipped: 0,
    movedTo: Array.from(movedTo),
  });
}

/**
 * Runs the deferred restack after a successful absorb, then clears the
 * absorb-progress marker. If the restack itself pauses on a conflict we
 * clear the marker first (so `dub continue` routes to `restackContinue`,
 * not back into the already-finished absorb) and surface `conflict: true`.
 */
async function finishAbsorbWithRestack(
  cwd: string,
  state: DubState,
  stack: Stack,
  mode: AbsorbMode,
  fields: {
    branch: string;
    absorbed: number;
    skipped: number;
    movedTo: string[];
  },
): Promise<AbsorbResult> {
  try {
    const restacked = await restackAfterAbsorb(cwd, state, stack);
    await clearAbsorbProgress(cwd);
    return {
      mode,
      ...fields,
      restacked,
      conflict: false,
      dryRun: false,
    };
  } catch (error) {
    if (error instanceof RestackConflictDuringAbsorb) {
      await clearAbsorbProgress(cwd);
      return {
        mode,
        ...fields,
        restacked: error.rebased,
        conflict: true,
        dryRun: false,
      };
    }
    await clearAbsorbProgress(cwd);
    throw error;
  }
}

async function collectCrossBranchFixups(
  stack: Stack,
  cwd: string,
): Promise<CrossFixup[]> {
  const ordered = topologicalOrder(stack).filter((b) => b.type !== 'root');
  const subjectIndex = new Map<string, { branch: string; sha: string }>();
  const branchCommits = new Map<string, CommitInfo[]>();

  for (const branch of ordered) {
    if (!branch.parent) continue;
    const base = await resolveAbsorbBase(branch.parent, branch.name, cwd);
    const commits = await listCommits(base, branch.name, cwd);
    branchCommits.set(branch.name, commits);
    for (const commit of commits) {
      if (FIXUP_PREFIX_RE.test(commit.subject)) continue;
      // Last-write-wins on duplicate subjects: scanning top-down ensures the
      // most-downstream branch claims a shared subject, which is the natural
      // owner when the same patch lives on multiple branches.
      subjectIndex.set(commit.subject, {
        branch: branch.name,
        sha: commit.sha,
      });
    }
  }

  const crossFixups: CrossFixup[] = [];
  for (const [sourceBranch, commits] of branchCommits) {
    for (const commit of commits) {
      const match = FIXUP_PREFIX_RE.exec(commit.subject);
      if (!match) continue;
      const targetSubject = match[2].trim();
      const target = subjectIndex.get(targetSubject);
      if (!target) continue;
      if (target.branch === sourceBranch) continue;
      crossFixups.push({
        sourceBranch,
        targetBranch: target.branch,
        fixupSha: commit.sha,
        targetSha: target.sha,
        subject: commit.subject,
      });
    }
  }
  return crossFixups;
}

async function cherryPickOrThrow(
  fixup: CrossFixup,
  targetBranch: string,
  cwd: string,
): Promise<void> {
  try {
    await execa('git', ['cherry-pick', fixup.fixupSha], { cwd });
  } catch {
    throw new DubError(
      `Conflict while cherry-picking '${fixup.subject}' onto '${targetBranch}'.`,
      [
        'Resolve conflicts and stage the resolved files.',
        "Run 'dub continue --ai' to let DubStack try the resolution.",
        "Run 'dub continue' to resume after resolving manually.",
        "Run 'dub abort' to cancel and roll back progress.",
      ],
    );
  }
}

/**
 * Resumes an absorb after the user has resolved conflicts and run
 * `dub continue`. Finishes whichever git operation paused (rebase from the
 * autosquash/AI modes, or cherry-pick from the cross-branch mode), then
 * runs the deferred restack and clears the absorb-progress marker.
 *
 * After a paused cherry-pick is continued we cannot transparently finish
 * the remaining --stack steps (drop the moved fixups from the source
 * branches and autosquash the targets), so we surface a recovery hint
 * instead of leaving state in a half-finished shape.
 */
export async function absorbContinue(cwd: string): Promise<AbsorbResult> {
  const progress = await readAbsorbProgress(cwd);
  if (!progress) {
    throw new DubError('No absorb in progress.', [
      "Run 'dub absorb' to autosquash 'fixup!' commits on the current branch.",
      "Run 'dub absorb --ai' to let DubStack pick targets for ambiguous WIP commits.",
    ]);
  }

  if (await hasCherryPickInProgress(cwd)) {
    try {
      await execa('git', ['cherry-pick', '--continue'], {
        cwd,
        env: { ...process.env, GIT_EDITOR: 'true' },
      });
    } catch {
      throw new DubError(
        'Failed to continue cherry-pick during cross-branch absorb.',
        [
          "Run 'git status' to see remaining unmerged paths.",
          "Run 'git add <file>' for each resolved file, then rerun 'dub continue'.",
          "Run 'dub abort' to cancel the absorb if it can't be continued.",
        ],
      );
    }
    await clearAbsorbProgress(cwd);
    throw new DubError(
      'Cherry-pick resolved, but cross-branch absorb cannot finish itself.',
      [
        "Run 'dub absorb --stack' again to resume moving any remaining fixups.",
        "Run 'dub restack' to rebase descendants now that the cherry-pick completed.",
      ],
    );
  }

  if (await hasGitRebaseInProgress(cwd)) {
    await rebaseContinue(cwd);
  }

  const state = await readState(cwd);
  const stack = findStackForBranch(state, progress.originalBranch);
  if (!stack || !progress.needsRestack) {
    await clearAbsorbProgress(cwd);
    return {
      mode: progress.mode,
      branch: progress.originalBranch,
      absorbed: 0,
      skipped: 0,
      movedTo: [],
      restacked: [],
      conflict: false,
      dryRun: false,
    };
  }

  // The paused rebase may have left HEAD on the original branch already, but
  // --stack mode pauses on arbitrary branches. Restack keys off the current
  // branch, so anchor it explicitly before deferring.
  const current = await getCurrentBranch(cwd);
  if (current !== progress.originalBranch) {
    await execa('git', ['checkout', progress.originalBranch], { cwd });
  }

  return finishAbsorbWithRestack(cwd, state, stack, progress.mode, {
    branch: progress.originalBranch,
    absorbed: 0,
    skipped: 0,
    movedTo: [],
  });
}

/**
 * Aborts an in-progress absorb. Aborts any running git operation (rebase
 * or cherry-pick) and clears the absorb-progress marker. Called by `dub
 * abort`.
 */
export async function absorbAbort(cwd: string): Promise<void> {
  if (await hasCherryPickInProgress(cwd)) {
    try {
      await execa('git', ['cherry-pick', '--abort'], { cwd });
    } catch {
      // best-effort: progress marker is still cleared below so the user
      // isn't stuck if cherry-pick state is already inconsistent
    }
  }
  if (await hasGitRebaseInProgress(cwd)) {
    await rebaseAbort(cwd);
  }
  await clearAbsorbProgress(cwd);
}

async function hasCherryPickInProgress(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await execa('git', ['rev-parse', '--git-dir'], { cwd });
    return fs.existsSync(path.join(stdout.trim(), 'CHERRY_PICK_HEAD'));
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  // POSIX single-quote escape: replace any internal single quote with
  // `'\''` so the resulting string is safe to drop into a `sh -c` argv.
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function getAbsorbProgressPath(cwd: string): Promise<string> {
  const dubDir = await getDubDir(cwd);
  return path.join(dubDir, 'absorb-progress.json');
}

async function writeAbsorbProgress(
  cwd: string,
  progress: AbsorbProgress,
): Promise<void> {
  const filePath = await getAbsorbProgressPath(cwd);
  fs.writeFileSync(filePath, `${JSON.stringify(progress, null, 2)}\n`);
}

async function readAbsorbProgress(cwd: string): Promise<AbsorbProgress | null> {
  const filePath = await getAbsorbProgressPath(cwd);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as AbsorbProgress;
}

async function clearAbsorbProgress(cwd: string): Promise<void> {
  const filePath = await getAbsorbProgressPath(cwd);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

async function snapshotStackTips(
  stack: Stack,
  cwd: string,
): Promise<Record<string, string>> {
  const tips: Record<string, string> = {};
  for (const branch of stack.branches) {
    try {
      tips[branch.name] = await getBranchTip(branch.name, cwd);
    } catch {
      // Branch may have been deleted out-of-band; skip rather than block undo.
    }
  }
  return tips;
}

function getParentForBranch(stack: Stack, branchName: string): string {
  const branch = stack.branches.find((b) => b.name === branchName);
  if (!branch || !branch.parent) {
    throw new DubError(
      `Branch '${branchName}' has no parent in its tracked stack.`,
      [
        "Run 'dub absorb' from a child branch (root branches have no parent to anchor the rebase).",
        "Run 'dub log' to see the stack layout.",
      ],
    );
  }
  return branch.parent;
}

async function resolveAbsorbBase(
  parentBranch: string,
  currentBranch: string,
  cwd: string,
): Promise<string> {
  return getMergeBase(parentBranch, currentBranch, cwd);
}

async function listCommits(
  base: string,
  head: string,
  cwd: string,
): Promise<CommitInfo[]> {
  const { stdout } = await execa(
    'git',
    ['log', `${base}..${head}`, '--reverse', '--format=%H%x1f%h%x1f%s'],
    { cwd },
  );
  const lines = stdout.split('\n').filter(Boolean);
  const commits: CommitInfo[] = [];
  for (const line of lines) {
    const [sha = '', shortSha = '', subject = ''] = line.split('\x1f');
    if (!sha) continue;
    const files = await listFilesForCommit(sha, cwd);
    commits.push({ sha, shortSha, subject, files });
  }
  return commits;
}

async function listFilesForCommit(sha: string, cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execa(
      'git',
      ['show', '--no-patch', '--name-only', '--format=', sha],
      { cwd },
    );
    return stdout.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function isWipCommit(commit: CommitInfo): boolean {
  const subject = commit.subject.trim();
  if (FIXUP_PREFIX_RE.test(subject)) return true;
  if (CONVENTIONAL_COMMIT_RE.test(subject)) return false;
  if (subject.length > 50) return false;
  if (commit.files.length > 1) return false;
  return WIP_SUBJECT_RE.test(subject) || subject.length <= 30;
}

async function runAutosquashRebase(base: string, cwd: string): Promise<void> {
  try {
    await execa('git', ['rebase', '--autosquash', '--interactive', base], {
      cwd,
      env: {
        ...process.env,
        GIT_SEQUENCE_EDITOR: 'true',
        GIT_EDITOR: 'true',
      },
    });
  } catch {
    throw new DubError('Conflict while absorbing fixup commits.', [
      'Resolve conflicts and stage the resolved files.',
      "Run 'dub continue --ai' to let DubStack try the resolution.",
      "Run 'dub continue' (or 'git rebase --continue') after resolving manually.",
      "Run 'dub abort' to cancel and roll back progress.",
    ]);
  }
}

async function runRebaseWithCustomTodo(
  base: string,
  todo: string,
  cwd: string,
): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dubstack-absorb-'));
  const todoPath = path.join(tmpDir, 'todo.txt');
  const editorPath = path.join(tmpDir, 'editor.cjs');
  fs.writeFileSync(todoPath, todo);
  fs.writeFileSync(
    editorPath,
    "const fs = require('fs');\n" +
      'const src = process.env.DUBSTACK_ABSORB_TODO;\n' +
      'const dest = process.argv[2];\n' +
      "fs.writeFileSync(dest, fs.readFileSync(src, 'utf8'));\n",
  );

  try {
    await execa('git', ['rebase', '--interactive', base], {
      cwd,
      env: {
        ...process.env,
        // Git invokes GIT_SEQUENCE_EDITOR via /bin/sh, so both paths need
        // shell-safe quoting in case the user's node binary or temp dir
        // sit under a path that contains spaces or special characters.
        GIT_SEQUENCE_EDITOR: `${shellQuote(process.execPath)} ${shellQuote(editorPath)}`,
        GIT_EDITOR: 'true',
        DUBSTACK_ABSORB_TODO: todoPath,
      },
    });
  } catch {
    throw new DubError('Conflict while absorbing WIP commits.', [
      'Resolve conflicts and stage the resolved files.',
      "Run 'dub continue --ai' to let DubStack try the resolution.",
      "Run 'dub continue' (or 'git rebase --continue') after resolving manually.",
      "Run 'dub abort' to cancel and roll back progress.",
    ]);
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup; rebase already finished by this point
    }
  }
}

interface AiAssignment {
  wipSha: string;
  targetSha: string | null;
}

async function aiPickTargets(
  wipCommits: CommitInfo[],
  candidates: CommitInfo[],
  allCommits: CommitInfo[],
  deps: AbsorbDependencies,
  providerConfig: Parameters<typeof resolveAiProvider>[0]['providerConfig'],
): Promise<AiAssignment[]> {
  const resolved = resolveAiProvider({ deps, providerConfig });
  const prompt = buildAiAbsorbPrompt(wipCommits, candidates);
  const result = await deps.generateText({
    model: resolved.model,
    system:
      'You assign WIP / fixup commits to earlier target commits on the same branch. Return strict JSON only — no commentary, no markdown fences.',
    prompt,
  });

  return parseAiAbsorbResponse(result.text, wipCommits, candidates, allCommits);
}

function buildAiAbsorbPrompt(
  wipCommits: CommitInfo[],
  candidates: CommitInfo[],
): string {
  const wipLines = wipCommits
    .map(
      (c) =>
        `- sha=${c.shortSha} subject="${c.subject}" files=${JSON.stringify(c.files)}`,
    )
    .join('\n');
  const targetLines = candidates
    .map(
      (c) =>
        `- sha=${c.shortSha} subject="${c.subject}" files=${JSON.stringify(c.files)}`,
    )
    .join('\n');
  return [
    'Pick a target commit for each WIP/fixup commit below. The target must be one of the earlier commits.',
    'Match by file overlap and subject semantics. If no target is a reasonable fit, return null for that wip.',
    '',
    'WIP_COMMITS:',
    wipLines,
    '',
    'TARGET_COMMITS:',
    targetLines,
    '',
    'Respond with strict JSON of the shape:',
    '{"assignments":[{"wipSha":"<short>","targetSha":"<short>"|null}]}',
  ].join('\n');
}

function parseAiAbsorbResponse(
  text: string,
  wipCommits: CommitInfo[],
  candidates: CommitInfo[],
  allCommits: CommitInfo[],
): AiAssignment[] {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new DubError('AI assistant returned invalid absorb targets.', [
      "Rerun 'dub absorb --ai' to retry generation.",
      "Run 'dub absorb' (no flag) to autosquash only literal 'fixup!' commits.",
    ]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new DubError('AI assistant returned invalid absorb targets.', [
      "Rerun 'dub absorb --ai' to retry generation.",
      "Run 'dub absorb' (no flag) to autosquash only literal 'fixup!' commits.",
    ]);
  }

  const raw =
    parsed && typeof parsed === 'object' && 'assignments' in parsed
      ? (parsed as { assignments?: unknown }).assignments
      : undefined;
  if (!Array.isArray(raw)) {
    throw new DubError('AI assistant returned invalid absorb targets.', [
      "Rerun 'dub absorb --ai' to retry generation.",
      "Run 'dub absorb' (no flag) to autosquash only literal 'fixup!' commits.",
    ]);
  }

  // Only resolve targets to *candidate* (non-WIP) commits. The AI is asked
  // to pick from the candidate list, but a hallucinated SHA — including any
  // WIP SHA — collapses to `null` so `buildCustomRebaseTodo` skips that WIP
  // instead of silently reordering history.
  const candidateShortToFull = new Map<string, string>();
  for (const c of candidates) {
    candidateShortToFull.set(c.shortSha, c.sha);
  }
  const candidateShaSet = new Set(candidates.map((c) => c.sha));
  const commitIndex = new Map<string, number>();
  for (let i = 0; i < allCommits.length; i++) {
    commitIndex.set(allCommits[i].sha, i);
  }

  const assignments: AiAssignment[] = [];
  for (const wip of wipCommits) {
    const entry = (raw as Array<Record<string, unknown>>).find(
      (item) => String(item.wipSha ?? '').trim() === wip.shortSha,
    );
    const rawTarget = entry?.targetSha;
    const targetShort =
      typeof rawTarget === 'string' && rawTarget.trim().length > 0
        ? rawTarget.trim()
        : null;
    let targetFull = targetShort
      ? (candidateShortToFull.get(targetShort) ?? null)
      : null;
    // Enforce target must (a) be a known non-WIP candidate and (b) appear
    // strictly earlier than the WIP in commit order. A later target would
    // mean `buildCustomRebaseTodo` reorders the WIP fixup *forward* into a
    // commit that didn't exist at the WIP's parent — silent history rewrite.
    if (targetFull !== null) {
      const wipIdx = commitIndex.get(wip.sha) ?? -1;
      const targetIdx = commitIndex.get(targetFull) ?? -1;
      if (
        !candidateShaSet.has(targetFull) ||
        wipIdx === -1 ||
        targetIdx === -1 ||
        targetIdx >= wipIdx
      ) {
        targetFull = null;
      }
    }
    assignments.push({ wipSha: wip.sha, targetSha: targetFull });
  }
  return assignments;
}

function buildCustomRebaseTodo(
  commits: CommitInfo[],
  assignments: AiAssignment[],
): string {
  const wipMap = new Map(assignments.map((a) => [a.wipSha, a.targetSha]));
  const wipShas = new Set(assignments.map((a) => a.wipSha));
  const todo: string[] = [];

  for (const commit of commits) {
    if (wipShas.has(commit.sha)) continue;
    todo.push(`pick ${commit.sha} ${commit.subject}`);
    for (const [wipSha, targetSha] of wipMap) {
      if (targetSha === commit.sha) {
        const wip = commits.find((c) => c.sha === wipSha);
        if (wip) todo.push(`fixup ${wipSha} ${wip.subject}`);
      }
    }
  }

  // WIP commits the AI couldn't assign keep their original position so the
  // user can decide what to do with them after the rebase.
  for (const commit of commits) {
    if (!wipShas.has(commit.sha)) continue;
    const target = wipMap.get(commit.sha);
    if (target !== null && target !== undefined) continue;
    todo.push(`pick ${commit.sha} ${commit.subject}`);
  }

  return `${todo.join('\n')}\n`;
}

function groupByField<T, K extends keyof T>(
  entries: T[],
  key: K,
): Map<T[K] & PropertyKey, T[]> {
  const grouped = new Map<T[K] & PropertyKey, T[]>();
  for (const entry of entries) {
    const k = entry[key] as T[K] & PropertyKey;
    const list = grouped.get(k) ?? [];
    list.push(entry);
    grouped.set(k, list);
  }
  return grouped;
}

async function dropCommitsFromBranch(
  branch: string,
  base: string,
  dropShas: string[],
  cwd: string,
): Promise<void> {
  await execa('git', ['checkout', branch], { cwd });
  const { stdout } = await execa(
    'git',
    ['log', '--reverse', '--format=%H%x1f%s', `${base}..${branch}`],
    { cwd },
  );
  const lines = stdout.split('\n').filter(Boolean);
  if (lines.length === 0) return;

  const dropSet = new Set(dropShas);
  const todoLines: string[] = [];
  for (const line of lines) {
    const [sha = '', subject = ''] = line.split('\x1f');
    if (!sha) continue;
    todoLines.push(
      dropSet.has(sha) ? `drop ${sha} ${subject}` : `pick ${sha} ${subject}`,
    );
  }
  const todo = `${todoLines.join('\n')}\n`;
  try {
    await runRebaseWithCustomTodo(base, todo, cwd);
  } catch (error) {
    if (error instanceof DubError && error.message.includes('Conflict')) {
      throw new DubError(
        `Conflict while dropping moved fixups from '${branch}'.`,
        [
          'Resolve conflicts and stage the resolved files.',
          "Run 'dub continue --ai' to let DubStack try the resolution.",
          "Run 'dub continue' to resume after resolving manually.",
          "Run 'dub abort' to cancel and roll back progress.",
        ],
      );
    }
    throw error;
  }
}

/**
 * Sentinel thrown by {@link restackAfterAbsorb} when the deferred restack
 * pauses on a merge conflict. Callers catch it, clear the absorb-progress
 * marker, and surface `conflict: true` so `dub continue` routes to
 * `restackContinue` (not back into the already-finished absorb).
 */
class RestackConflictDuringAbsorb extends Error {
  readonly conflictBranch: string | undefined;
  readonly rebased: string[];
  constructor(rebased: string[], conflictBranch: string | undefined) {
    super(`Restack paused on conflict during absorb on '${conflictBranch}'.`);
    this.name = 'RestackConflictDuringAbsorb';
    this.conflictBranch = conflictBranch;
    this.rebased = rebased;
  }
}

async function restackAfterAbsorb(
  cwd: string,
  _state: DubState,
  _stack: Stack,
): Promise<string[]> {
  try {
    const result = await restack(cwd, { skipUndoEntry: true });
    if (result.status === 'conflict') {
      throw new RestackConflictDuringAbsorb(
        result.rebased,
        result.conflictBranch,
      );
    }
    return result.rebased;
  } catch (error) {
    if (error instanceof RestackConflictDuringAbsorb) throw error;
    if (error instanceof DubError) throw error;
    throw new DubError(
      `Auto-restack after absorb failed: ${error instanceof Error ? error.message : String(error)}`,
      [
        "Run 'dub restack' manually to rebase descendants.",
        "Run 'dub doctor' to inspect stack health.",
      ],
    );
  }
}
