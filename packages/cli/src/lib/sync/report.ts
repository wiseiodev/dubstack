import chalk from 'chalk';
import { getActiveProgress } from '../progress';
import type { BranchSyncOutcome, SyncResult } from './types';

export function printBranchOutcome(outcome: BranchSyncOutcome): void {
  const progress = getActiveProgress();
  if (progress) progress.pause();
  try {
    if (outcome.action === 'error') {
      console.error(
        chalk.red(`✖ Failed to sync '${outcome.branch}': ${outcome.message}`),
      );
      if (outcome.recovery && outcome.recovery.length > 0) {
        console.error(chalk.red('  What you can do:'));
        outcome.recovery.forEach((step, idx) => {
          console.error(chalk.red(`    ${idx + 1}. ${step}`));
        });
      }
      return;
    }
    console.log(outcome.message);
  } finally {
    if (progress) progress.resume();
  }
}

export function printSyncSummary(result: SyncResult): void {
  const synced = result.branches.filter((b) => b.action === 'synced').length;
  const skipped = result.branches.filter((b) => b.action === 'skipped').length;
  const keptLocal = result.branches.filter(
    (b) => b.action === 'kept-local',
  ).length;
  const cached = result.branches.filter((b) => b.status === 'fresh').length;
  const errored = result.branches.filter((b) => b.action === 'error');
  const worktreeSkipped = result.branches.filter(
    (b) => b.status === 'checked-out-elsewhere',
  ).length;
  const worktreeSuffix =
    worktreeSkipped > 0 ? ` (${worktreeSkipped} checked-out-elsewhere)` : '';
  const cachedSuffix = cached > 0 ? `, ${cached} fresh-cached` : '';
  const counts = `${synced} synced, ${keptLocal} kept-local, ${skipped} skipped${worktreeSuffix}${cachedSuffix}, ${result.cleaned.length} cleaned, ${errored.length} errored`;
  if (errored.length > 0) {
    console.error(chalk.yellow(`⚠ Sync completed with errors: ${counts}`));
    console.error(
      chalk.red(`✖ ${errored.length} branch(es) hit unexpected errors:`),
    );
    for (const outcome of errored) {
      const [firstLine, ...rest] = outcome.message.split('\n');
      console.error(chalk.red(`  • ${outcome.branch}: ${firstLine}`));
      for (const line of rest) {
        console.error(chalk.red(`      ${line}`));
      }
    }
    return;
  }
  console.log(`✔ Sync complete: ${counts}`);
}
