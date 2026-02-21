# Dub Sync Parity Design

**Date:** 2026-02-21
**Status:** Approved
**Owner:** DubStack CLI

## 1. Problem Statement

DubStack needs a `dub sync` command with behavior close to Graphite's `gt sync`, including:
- fetching and syncing trunk + tracked branches from remote,
- cleaning up merged/closed branches safely,
- reconciling local and remote divergence with interactive decisions,
- optional restacking after sync.

The current codebase has robust `create`, `submit`, `restack`, and local stack state, but lacks branch-level remote reconciliation and sync metadata needed for parity decisions.

## 2. Goals

- Implement `dub sync` with interactive and non-interactive flows.
- Match Graphite-style phase ordering and user-facing intent.
- Preserve safety by default; only destructive actions under explicit user choice or `--force`.
- Maintain deterministic behavior in non-interactive mode.
- Keep architecture modular and testable.

## 3. Non-Goals (Initial Parity Scope)

- Perfect wire-level parity with Graphite internal APIs.
- Server-side features that depend on private Graphite backend semantics.
- Replacing existing `submit` behavior in this phase.

## 4. Command Contract

### Command
- `dub sync`

### Flags
- `--restack` (default `true`, supports `--no-restack`)
- `-f, --force`
- `-a, --all`
- `--no-interactive` (explicitly disable prompts; otherwise inferred from TTY)

### Phase Output
1. `🌲 Fetching branches from remote...`
2. Trunk update reporting
3. `🧹 Cleaning up branches with merged/closed PRs...`
4. `🔄 Syncing branches...`
5. Optional `🥞 Restacking branches...`

## 5. Architecture

### 5.1 Orchestrator
- `src/commands/sync.ts`
- Responsibilities:
  - parse options and build sync context,
  - select branches/trunks in scope,
  - execute phase pipeline,
  - aggregate and print summary.

### 5.2 Sync Modules

- `src/lib/sync/types.ts`
  - shared interfaces/enums: `SyncOptions`, `SyncContext`, `BranchSyncStatus`, `SyncDecision`, `SyncResult`.

- `src/lib/sync/fetch.ts`
  - remote fetch for trunks + candidate branches
  - optional progress callbacks.

- `src/lib/sync/trunk.ts`
  - sync trunk branches with fast-forward checks,
  - prompt/force handling when overwrite is needed.

- `src/lib/sync/cleanup.ts`
  - determine branches eligible for cleanup from PR state,
  - enforce safety checks (merged ancestry, protected descendants),
  - prompt or apply forced deletion.

- `src/lib/sync/branch-status.ts`
  - classify each branch into status bucket:
    - `missing-remote`
    - `missing-local`
    - `untracked`
    - `unsubmitted`
    - `up-to-date`
    - `updated-outside-dubstack-but-up-to-date`
    - `new-parent-with-remote-change`
    - `reconcile-needed`
    - `needs-remote-sync-safe`
    - `needs-remote-sync`

- `src/lib/sync/reconcile.ts`
  - compute reconciled candidate (if cleanly possible),
  - interactive decision tree for ambiguous states,
  - deterministic fallback in non-interactive mode.

- `src/lib/sync/apply.ts`
  - perform mutations for decisions (`take-remote`, `keep-local-baseline-update`, `reconcile`, `reconcile-alt-parent`).

- `src/lib/sync/report.ts`
  - stable user-facing event and summary rendering.

## 6. Data Model Changes

Current `DubState` must expand with sync metadata per branch.

### Proposed `Branch` additions
- `last_submitted_version`: nullable object
  - `head_sha: string`
  - `base_sha: string`
  - `base_branch: string`
  - `version_number: number | null`
  - `source: "submit" | "sync" | "imported"`
- `last_synced_at: string | null`
- `sync_source: "submit" | "sync" | "imported" | null`

These fields support parity behavior such as:
- preserving local state while updating baseline,
- distinguishing remote updates created outside DubStack,
- making safe overwrite/reconcile choices.

## 7. Detailed Behavior

### 7.1 Scope Selection
- Default: current trunk relative upstack (tracked).
- `--all`: all tracked branches across trunks.

### 7.2 Trunk Sync
- Attempt FF update from remote.
- On non-FF:
  - interactive: prompt to overwrite local trunk,
  - `--force`: overwrite directly,
  - non-interactive without force: skip + warning.

### 7.3 Cleanup
- Detect branches whose PRs are merged/closed and cleanable.
- Delete safely when commits are confirmed landed in trunk.
- If not cleanable, print grouped warning and exclude descendants from sync.

### 7.4 Branch Status Handling

- `missing-remote`
  - if no compatible remote provenance: warn and skip.

- `missing-local`
  - create branch from remote version and record metadata.

- `untracked`
  - interactive prompt to overwrite local with remote,
  - force: overwrite,
  - non-interactive no force: skip warning.

- `unsubmitted`
  - if already equal to remote: informational,
  - else interactive/force branch-overwrite decision.

- `up-to-date`
  - update baseline metadata; if both sides restacked, prompt keep-local vs take-remote.

- `updated-outside-dubstack-but-up-to-date`
  - informational; refresh baseline metadata only.

- `new-parent-with-remote-change` / `needs-remote-sync-safe`
  - apply remote sync with reconciled parent/base/head.

- `reconcile-needed`
  - try clean reconciliation,
  - if impossible: prompt remote/local/cancel (or force remote in `--force`).

- `needs-remote-sync`
  - handle parent mismatch:
    - take remote on local parent,
    - take remote with remote parent,
    - keep local (baseline update).

### 7.5 Restack Phase
- If `--restack` and eligible, call existing restack routines on relevant roots.
- Surface conflicts clearly and preserve recovery instructions.

## 8. UX and Error Philosophy

- Use actionable `DubError` messages.
- Never silently discard user work.
- Non-interactive mode must be deterministic and conservative.
- `--force` explicitly opts into destructive sync paths.

## 9. Testing Strategy

### Unit Tests
- `src/lib/sync/branch-status.test.ts`
- `src/lib/sync/reconcile.test.ts`
- `src/lib/sync/cleanup.test.ts`
- `src/lib/sync/apply.test.ts`

### Command Tests
- `src/commands/sync.test.ts`
  - phase ordering,
  - force vs interactive vs non-interactive,
  - all status families,
  - restack integration path.

### Regression/Verification
- `pnpm test`
- `pnpm typecheck`
- `pnpm checks`

## 10. Risks and Mitigations

- **Risk:** incorrect destructive action during sync
  - **Mitigation:** default-safe behavior, explicit force gates, test matrix for every status.

- **Risk:** state schema migration bugs
  - **Mitigation:** migration helper + backward-compatible reads + tests with legacy fixtures.

- **Risk:** branching stacks edge cases
  - **Mitigation:** explicit checks, clear warnings, skip unsupported scenarios with guidance.

## 11. Rollout Plan

1. Introduce sync metadata schema + migration.
2. Implement deterministic status + apply pipeline.
3. Add interactive decision tree.
4. Add cleanup and post-sync restack.
5. Harden output + docs.

## 12. Success Criteria

- `dub sync` can run on active stacks and reconcile with remote safely.
- Interactive parity decisions exist for divergence scenarios.
- Non-interactive behavior is conservative and explicit.
- Full test suite passes with new sync coverage.
