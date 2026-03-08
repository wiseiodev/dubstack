import { execa } from 'execa';
import { DubError } from '../lib/errors';
import { rebaseContinue } from '../lib/git';
import { detectActiveOperation } from '../lib/operation-state';
import { aiResolve } from './ai-resolve';
import { restackContinue } from './restack';

interface ContinueCommandResult {
  continued: 'rebase' | 'restack' | 'ai-resolve';
  restackResult?: Awaited<ReturnType<typeof restackContinue>>;
}

export async function continueCommand(
  cwd: string,
  options?: { ai?: boolean },
): Promise<ContinueCommandResult> {
  if (options?.ai) {
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
  }

  const active = await detectActiveOperation(cwd);
  if (active === 'none') {
    throw new DubError(
      'No operation in progress. Start a restack or resolve a rebase first.',
    );
  }

  if (active === 'restack') {
    const restackResult = await restackContinue(cwd);
    return { continued: 'restack', restackResult };
  }

  await rebaseContinue(cwd);
  return { continued: 'rebase' };
}
