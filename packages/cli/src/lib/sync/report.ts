import type { BranchSyncOutcome, SyncResult } from './types';

export function printBranchOutcome(outcome: BranchSyncOutcome): void {
  console.log(outcome.message);
}

export function printSyncSummary(result: SyncResult): void {
  const synced = result.branches.filter((b) => b.action === 'synced').length;
  const skipped = result.branches.filter((b) => b.action === 'skipped').length;
  const keptLocal = result.branches.filter(
    (b) => b.action === 'kept-local',
  ).length;
  const cached = result.branches.filter((b) => b.status === 'fresh').length;
  const worktreeSkipped = result.branches.filter(
    (b) => b.status === 'checked-out-elsewhere',
  ).length;
  const worktreeSuffix =
    worktreeSkipped > 0 ? ` (${worktreeSkipped} checked-out-elsewhere)` : '';
  const cachedSuffix = cached > 0 ? `, ${cached} fresh-cached` : '';
  console.log(
    `✔ Sync complete: ${synced} synced, ${keptLocal} kept-local, ${skipped} skipped${worktreeSuffix}${cachedSuffix}, ${result.cleaned.length} cleaned`,
  );
}
