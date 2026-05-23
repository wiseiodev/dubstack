export type BranchSyncStatus =
  | 'missing-remote'
  | 'missing-local'
  | 'up-to-date'
  | 'updated-outside-dubstack-but-up-to-date'
  | 'unsubmitted'
  | 'checked-out-elsewhere'
  | 'needs-remote-sync-safe'
  | 'needs-remote-sync'
  | 'reconcile-needed'
  | 'local-ahead'
  | 'fresh';

export interface SyncOptions {
  force: boolean;
  restack: boolean;
  all: boolean;
  interactive: boolean;
  fresh: boolean;
}

export interface BranchSyncOutcome {
  branch: string;
  status: BranchSyncStatus;
  action: 'synced' | 'kept-local' | 'skipped' | 'deleted' | 'none' | 'cached';
  message: string;
}

export interface SyncResult {
  fetched: string[];
  trunksSynced: string[];
  cleaned: string[];
  branches: BranchSyncOutcome[];
  restacked: boolean;
}
