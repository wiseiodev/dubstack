import * as fs from 'node:fs';
import * as path from 'node:path';
import { DubError } from '../lib/errors';
import { getRepoRoot, isGitRepo } from '../lib/git';
import { initState } from '../lib/state';

interface InitResult {
  status: 'created' | 'already_exists';
  gitignoreUpdated: boolean;
}

/**
 * Initializes DubStack in the current git repository.
 *
 * Creates `.git/dubstack/state.json` with an empty state and ensures
 * `.git/dubstack` is listed in `.gitignore`. Idempotent — safe to run
 * multiple times.
 *
 * @param cwd - Working directory (must be inside a git repo)
 * @returns Status indicating whether state was created or already existed
 * @throws {DubError} If not inside a git repository
 */
export async function init(cwd: string): Promise<InitResult> {
  if (!(await isGitRepo(cwd))) {
    throw new DubError('Not a git repository.', [
      "Run 'git init' in the desired project directory.",
      "Run 'cd <repo>' to switch into an existing git repository, then rerun 'dub init'.",
    ]);
  }

  const status = await initState(cwd);
  const repoRoot = await getRepoRoot(cwd);
  const gitignorePath = path.join(repoRoot, '.gitignore');
  const entry = '.git/dubstack';
  let gitignoreUpdated = false;

  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, 'utf-8');
    const lines = content.split('\n');
    if (!lines.some((line) => line.trim() === entry)) {
      const separator = content.endsWith('\n') ? '' : '\n';
      fs.writeFileSync(gitignorePath, `${content}${separator}${entry}\n`);
      gitignoreUpdated = true;
    }
  } else {
    fs.writeFileSync(gitignorePath, `${entry}\n`);
    gitignoreUpdated = true;
  }

  return { status, gitignoreUpdated };
}
