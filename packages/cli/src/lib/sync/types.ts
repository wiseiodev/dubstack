export type BranchSyncStatus =
  | 'missing-remote'
  | 'missing-local'
  | 'up-to-date'
  | 'updated-outside-dubstack-but-up-to-date'
  | 'unsubmitted'
  | 'checked-out-elsewhere'
  | 'frozen-skipped'
  | 'needs-remote-sync-safe'
  | 'needs-remote-sync'
  | 'reconcile-needed'
  | 'local-ahead'
  | 'remote-restacked'
  | 'squash-merged-with-trailing-commits'
  | 'non-conflicting-divergence'
  | 'parent-merged-orphan'
  | 'fresh'
  | 'error';

export type ReconcileSource =
  | 'submit'
  | 'sync-no-change'
  | 'sync-adopt-remote-safe'
  | 'sync-adopt-remote-divergent'
  | 'sync-adopt-remote-parent'
  | 'sync-rebase-onto-remote'
  | 'sync-rebase-onto-parent'
  | 'sync-remote-restacked'
  | 'sync-parent-merged-reparent'
  | 'sync-squash-merged-cleanup'
  | 'sync-keep-local'
  | 'sync-skip'
  | 'sync-force'
  | 'imported';

export const RECONCILE_SOURCES: readonly ReconcileSource[] = [
  'submit',
  'sync-no-change',
  'sync-adopt-remote-safe',
  'sync-adopt-remote-divergent',
  'sync-adopt-remote-parent',
  'sync-rebase-onto-remote',
  'sync-rebase-onto-parent',
  'sync-remote-restacked',
  'sync-parent-merged-reparent',
  'sync-squash-merged-cleanup',
  'sync-keep-local',
  'sync-skip',
  'sync-force',
  'imported',
] as const;

export type ReconcileSourceHistogram = Partial<Record<ReconcileSource, number>>;

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
  action:
    | 'synced'
    | 'kept-local'
    | 'skipped'
    | 'deleted'
    | 'none'
    | 'cached'
    | 'error';
  message: string;
  reconcileSource?: ReconcileSource;
  recovery?: string[];
}

export interface SyncResult {
  fetched: string[];
  trunksSynced: string[];
  cleaned: string[];
  branches: BranchSyncOutcome[];
  restacked: boolean;
  reconcileSources: ReconcileSourceHistogram;
}
