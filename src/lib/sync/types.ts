export type BranchSyncStatus =
	| "missing-remote"
	| "missing-local"
	| "up-to-date"
	| "updated-outside-dubstack-but-up-to-date"
	| "unsubmitted"
	| "needs-remote-sync-safe"
	| "reconcile-needed"
	| "local-ahead";

export interface SyncOptions {
	force: boolean;
	restack: boolean;
	all: boolean;
	interactive: boolean;
}

export interface BranchSyncOutcome {
	branch: string;
	status: BranchSyncStatus;
	action: "synced" | "kept-local" | "skipped" | "deleted" | "none";
	message: string;
}

export interface SyncResult {
	fetched: string[];
	trunksSynced: string[];
	cleaned: string[];
	branches: BranchSyncOutcome[];
	restacked: boolean;
}
