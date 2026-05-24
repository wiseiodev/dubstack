import * as fs from 'node:fs';
import * as path from 'node:path';
import { hasCleanupJournal } from './cleanup-journal';
import { getRepoRoot } from './git';
import { getDubDir } from './state';

export type ActiveOperation =
  | 'none'
  | 'rebase'
  | 'restack'
  | 'cleanup'
  | 'absorb';

async function getAbsorbProgressPath(cwd: string): Promise<string> {
  const dubDir = await getDubDir(cwd);
  return path.join(dubDir, 'absorb-progress.json');
}

export async function hasAbsorbProgress(cwd: string): Promise<boolean> {
  return fs.existsSync(await getAbsorbProgressPath(cwd));
}

export async function getRestackProgressPath(cwd: string): Promise<string> {
  const dubDir = await getDubDir(cwd);
  return path.join(dubDir, 'restack-progress.json');
}

export async function hasRestackProgress(cwd: string): Promise<boolean> {
  const progressPath = await getRestackProgressPath(cwd);
  return fs.existsSync(progressPath);
}

export async function hasGitRebaseInProgress(cwd: string): Promise<boolean> {
  const root = await getRepoRoot(cwd);
  const rebaseMerge = path.join(root, '.git', 'rebase-merge');
  const rebaseApply = path.join(root, '.git', 'rebase-apply');
  return fs.existsSync(rebaseMerge) || fs.existsSync(rebaseApply);
}

export async function detectActiveOperation(
  cwd: string,
): Promise<ActiveOperation> {
  // Absorb owns both the rebase-in-progress *and* a deferred restack, so it
  // takes precedence over the plain rebase signal — otherwise `dub continue`
  // would finish the rebase and skip the deferred restack.
  if (await hasAbsorbProgress(cwd)) return 'absorb';
  if (await hasRestackProgress(cwd)) return 'restack';
  if (await hasGitRebaseInProgress(cwd)) return 'rebase';
  // Cleanup is the lowest-priority signal: a git rebase or restack in flight
  // takes precedence so users finish their interactive operation first.
  if (await hasCleanupJournal(cwd)) return 'cleanup';
  return 'none';
}

export async function clearRestackProgress(cwd: string): Promise<void> {
  const progressPath = await getRestackProgressPath(cwd);
  if (!fs.existsSync(progressPath)) return;
  fs.unlinkSync(progressPath);
}
