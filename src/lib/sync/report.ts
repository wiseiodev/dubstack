import type { BranchSyncOutcome, SyncResult } from "./types";

export function printBranchOutcome(outcome: BranchSyncOutcome): void {
	console.log(outcome.message);
}

export function printSyncSummary(result: SyncResult): void {
	const synced = result.branches.filter((b) => b.action === "synced").length;
	const skipped = result.branches.filter((b) => b.action === "skipped").length;
	const keptLocal = result.branches.filter(
		(b) => b.action === "kept-local",
	).length;
	console.log(
		`✔ Sync complete: ${synced} synced, ${keptLocal} kept-local, ${skipped} skipped, ${result.cleaned.length} cleaned`,
	);
}
