import { execa } from 'execa';
import { resumeCleanup } from '../lib/cleanup-resume';
import { DubError } from '../lib/errors';
import { rebaseContinue } from '../lib/git';
import { detectActiveOperation } from '../lib/operation-state';
import { aiResolve } from './ai-resolve';
import { restackContinue } from './restack';

interface ContinueCommandResult {
  continued: 'rebase' | 'restack' | 'ai-resolve' | 'cleanup';
  restackResult?: Awaited<ReturnType<typeof restackContinue>>;
  cleanupResult?: Awaited<ReturnType<typeof resumeCleanup>>;
}

export async function continueCommand(
  cwd: string,
  options?: { ai?: boolean },
): Promise<ContinueCommandResult> {
  if (options?.ai) {
    try {
      const { stdout } = await execa(
        'git',
        ['diff', '--name-only', '--diff-filter=U'],
        { cwd },
      );
      const conflicted = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);

      if (conflicted.length > 0) {
        await aiResolve(cwd, {});
        return { continued: 'ai-resolve' };
      }
    } catch {
      throw new DubError('Failed to check for merge conflicts.', [
        "Run 'git status' to confirm you are inside a git repository.",
        'Resolve any underlying git errors and retry the command.',
      ]);
    }
  }

  const active = await detectActiveOperation(cwd);
  if (active === 'none') {
    throw new DubError('No operation in progress.', [
      "Run 'dub restack' to start restacking the current stack.",
      "Run 'git rebase --continue' if you have an in-progress rebase outside DubStack.",
    ]);
  }

  if (active === 'restack') {
    const restackResult = await restackContinue(cwd);
    return { continued: 'restack', restackResult };
  }

  if (active === 'cleanup') {
    const cleanupResult = await resumeCleanup(cwd);
    return { continued: 'cleanup', cleanupResult };
  }

  await rebaseContinue(cwd);
  return { continued: 'rebase' };
}
