import { clearCleanupJournal } from '../lib/cleanup-journal';
import { DubError } from '../lib/errors';
import { rebaseAbort } from '../lib/git';
import {
  clearRestackProgress,
  detectActiveOperation,
  hasGitRebaseInProgress,
} from '../lib/operation-state';
import { absorbAbort } from './absorb';

interface AbortCommandResult {
  aborted: 'rebase' | 'restack' | 'cleanup' | 'absorb';
}

export async function abortCommand(cwd: string): Promise<AbortCommandResult> {
  const active = await detectActiveOperation(cwd);
  if (active === 'none') {
    throw new DubError('No operation in progress.', [
      "Run 'dub log' to inspect the stack.",
      "Run 'dub restack' to start restacking the current stack if you intended to.",
    ]);
  }

  if (active === 'absorb') {
    await absorbAbort(cwd);
    return { aborted: active };
  }

  if (await hasGitRebaseInProgress(cwd)) {
    await rebaseAbort(cwd);
  }
  if (active === 'restack') {
    await clearRestackProgress(cwd);
  }
  if (active === 'cleanup') {
    await clearCleanupJournal(cwd);
  }

  return { aborted: active };
}
