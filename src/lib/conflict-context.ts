import * as fs from 'node:fs';
import { execa } from 'execa';
import { DubError } from './errors';
import { getCurrentBranch } from './git';
import {
  detectActiveOperation,
  getRestackProgressPath,
  hasRestackProgress,
} from './operation-state';
import { findStackForBranch, readState } from './state';

interface RestackStepInfo {
  branch: string;
  parent: string;
  parentOldTip: string;
  parentNewTip?: string;
  status: 'pending' | 'done' | 'skipped' | 'conflicted';
}

export interface ConflictContext {
  operation: 'rebase' | 'restack';
  conflictedBranch: string;
  parentBranch: string;
  conflictedFiles: string[];
  conflictMarkers: Record<string, string>;
  upstreamCommits: string;
  replayedCommits: string;
  restackStep?: RestackStepInfo;
  remainingSteps?: number;
  scopeWarning?: string;
}

const SCOPE_MAX_FILES = 10;
const SCOPE_MAX_MARKER_LINES = 5000;

export async function gatherConflictContext(
  cwd: string,
): Promise<ConflictContext> {
  const operation = await detectActiveOperation(cwd);
  if (operation === 'none') {
    throw new DubError(
      'No active rebase or restack operation. Nothing to resolve.',
    );
  }

  const conflictedFiles = await getConflictedFiles(cwd);

  const conflictMarkers: Record<string, string> = {};
  let totalMarkerLines = 0;
  for (const file of conflictedFiles) {
    try {
      const content = fs.readFileSync(`${cwd}/${file}`, 'utf-8');
      conflictMarkers[file] = content;
      totalMarkerLines += content.split('\n').length;
    } catch {
      // file may have been deleted in one side
    }
  }

  // During rebase: HEAD = upstream/base being rebased onto, REBASE_HEAD = commit being replayed
  const [upstreamCommits, replayedCommits] = await Promise.all([
    getLogOutput(cwd, 'HEAD'),
    getLogOutput(cwd, 'REBASE_HEAD'),
  ]);

  const { conflictedBranch, parentBranch } = await resolveBranches(
    cwd,
    operation,
  );

  let restackStep: RestackStepInfo | undefined;
  let remainingSteps: number | undefined;

  if (await hasRestackProgress(cwd)) {
    const progressPath = await getRestackProgressPath(cwd);
    const raw = fs.readFileSync(progressPath, 'utf-8');
    const progress = JSON.parse(raw) as {
      steps: RestackStepInfo[];
    };
    restackStep = progress.steps.find((s) => s.status === 'conflicted');
    remainingSteps = progress.steps.filter(
      (s) => s.status === 'pending',
    ).length;
  }

  let scopeWarning: string | undefined;
  if (conflictedFiles.length > SCOPE_MAX_FILES) {
    scopeWarning = `${conflictedFiles.length} conflicted files exceeds the ${SCOPE_MAX_FILES}-file threshold for AI-assisted resolution.`;
  } else if (totalMarkerLines > SCOPE_MAX_MARKER_LINES) {
    scopeWarning = `${totalMarkerLines} total lines in conflicted files exceeds the ${SCOPE_MAX_MARKER_LINES}-line threshold for AI-assisted resolution.`;
  }

  return {
    operation,
    conflictedBranch,
    parentBranch,
    conflictedFiles,
    conflictMarkers,
    upstreamCommits,
    replayedCommits,
    restackStep,
    remainingSteps,
    scopeWarning,
  };
}

async function getConflictedFiles(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execa(
      'git',
      ['diff', '--name-only', '--diff-filter=U'],
      { cwd },
    );
    return stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function getLogOutput(cwd: string, ref: string): Promise<string> {
  try {
    const { stdout } = await execa('git', ['log', '--oneline', '-10', ref], {
      cwd,
    });
    return stdout;
  } catch {
    return '';
  }
}

async function resolveBranches(
  cwd: string,
  operation: 'rebase' | 'restack',
): Promise<{ conflictedBranch: string; parentBranch: string }> {
  if (operation === 'restack' && (await hasRestackProgress(cwd))) {
    const progressPath = await getRestackProgressPath(cwd);
    const raw = fs.readFileSync(progressPath, 'utf-8');
    const progress = JSON.parse(raw) as {
      steps: RestackStepInfo[];
    };
    const conflicted = progress.steps.find((s) => s.status === 'conflicted');
    if (conflicted) {
      return {
        conflictedBranch: conflicted.branch,
        parentBranch: conflicted.parent,
      };
    }
  }

  // Fall back to git state
  const currentBranch = await getCurrentBranch(cwd).catch(() => 'unknown');
  let parentBranch = 'unknown';
  try {
    const state = await readState(cwd);
    const stack = findStackForBranch(state, currentBranch);
    if (stack) {
      const branch = stack.branches.find((b) => b.name === currentBranch);
      if (branch?.parent) {
        parentBranch = branch.parent;
      }
    }
  } catch {
    // state may not be readable during conflict
  }

  return { conflictedBranch: currentBranch, parentBranch };
}
