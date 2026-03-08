import * as fs from 'node:fs';
import * as path from 'node:path';
import { getRepoRoot } from './git';
import { getDubDir } from './state';

export type ActiveOperation = 'none' | 'rebase' | 'restack';

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
  if (await hasRestackProgress(cwd)) return 'restack';
  if (await hasGitRebaseInProgress(cwd)) return 'rebase';
  return 'none';
}

export async function clearRestackProgress(cwd: string): Promise<void> {
  const progressPath = await getRestackProgressPath(cwd);
  if (!fs.existsSync(progressPath)) return;
  fs.unlinkSync(progressPath);
}
