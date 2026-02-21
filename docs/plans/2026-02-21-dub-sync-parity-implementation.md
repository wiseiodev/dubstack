# Dub Sync Parity Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a `dub sync` command with Graphite-like parity for fetch/trunk sync/cleanup/reconcile/restack flows, including full interactive decision paths.

**Architecture:** Implement a pipeline-based sync system (`fetch` -> `trunk` -> `cleanup` -> `branch status + apply` -> `restack`) in `src/lib/sync/*`, orchestrated by `src/commands/sync.ts`. Extend branch state with sync baseline metadata so decisions like keep-local vs take-remote remain safe and deterministic.

**Tech Stack:** TypeScript (ESM), Commander, Execa/git/gh CLI integration, Vitest, Biome.

---

### Task 1: Add sync metadata schema and migration helpers

**Files:**
- Modify: `src/lib/state.ts`
- Test: `src/lib/state.test.ts`

**Step 1: Write failing tests for backward-compatible state reads**

Add tests that load legacy branch objects without sync fields and expect defaults:
```ts
expect(branch.last_submitted_version).toBeNull();
expect(branch.last_synced_at).toBeNull();
expect(branch.sync_source).toBeNull();
```

**Step 2: Run targeted test to verify failure**

Run: `pnpm test src/lib/state.test.ts`
Expected: FAIL due to missing fields/defaulting.

**Step 3: Implement minimal schema extension + normalization**

In `src/lib/state.ts`:
- Add new branch fields and types.
- Add `normalizeState(...)` invoked by `readState`.
- Ensure new branches created by existing commands include defaults.

**Step 4: Re-run targeted test**

Run: `pnpm test src/lib/state.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/state.ts src/lib/state.test.ts
git commit -m "feat(sync): add branch sync metadata schema and normalization"
```

### Task 2: Add git helpers required by sync pipeline

**Files:**
- Modify: `src/lib/git.ts`
- Test: `src/lib/git.test.ts`

**Step 1: Write failing tests for sync-oriented primitives**

Add tests for:
- branch upstream existence checks,
- commit equality checks between refs,
- safe reset-to-remote helper behavior,
- fetch branch list helper.

**Step 2: Run targeted tests to verify failure**

Run: `pnpm test src/lib/git.test.ts`
Expected: FAIL for missing helper APIs.

**Step 3: Implement minimal helpers in `src/lib/git.ts`**

Add small pure wrappers:
- `fetchBranches(branches, cwd, onProgress?)`
- `refEquals(a, b, cwd)`
- `hardResetTo(ref, cwd)`
- `getRemoteHeadRef(branch, remote, cwd)`

**Step 4: Re-run targeted tests**

Run: `pnpm test src/lib/git.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/git.ts src/lib/git.test.ts
git commit -m "feat(sync): add git primitives for branch sync workflows"
```

### Task 3: Add sync type system and shared context builders

**Files:**
- Create: `src/lib/sync/types.ts`
- Create: `src/lib/sync/context.ts`
- Test: `src/lib/sync/context.test.ts`

**Step 1: Write failing tests for context construction**

Test that context includes:
- `cwd`, `interactive`, `force`, `all`, `restack`,
- current state, current branch, target trunks/branches.

**Step 2: Run targeted tests**

Run: `pnpm test src/lib/sync/context.test.ts`
Expected: FAIL until module exists.

**Step 3: Implement types + context builder**

Define:
- `BranchSyncStatus` union,
- `SyncDecision` union,
- `SyncOptions`, `SyncSummary`, `SyncContext`.

Add `buildSyncContext(cwd, options)`.

**Step 4: Re-run targeted tests**

Run: `pnpm test src/lib/sync/context.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/sync/types.ts src/lib/sync/context.ts src/lib/sync/context.test.ts
git commit -m "feat(sync): introduce sync context and status/decision types"
```

### Task 4: Implement fetch and trunk sync phases

**Files:**
- Create: `src/lib/sync/fetch.ts`
- Create: `src/lib/sync/trunk.ts`
- Test: `src/lib/sync/fetch.test.ts`
- Test: `src/lib/sync/trunk.test.ts`

**Step 1: Write failing tests for fetch/trunk outcomes**

Cover:
- empty fetch list no-op,
- trunk fast-forward success,
- non-FF trunk with interactive prompt,
- non-FF trunk with `--force`,
- non-interactive no-force skip.

**Step 2: Run targeted tests**

Run: `pnpm test src/lib/sync/fetch.test.ts src/lib/sync/trunk.test.ts`
Expected: FAIL.

**Step 3: Implement phase modules**

- `runFetchPhase(ctx)` with user progress hooks.
- `runTrunkPhase(ctx)` returning per-trunk result statuses.

**Step 4: Re-run targeted tests**

Run: `pnpm test src/lib/sync/fetch.test.ts src/lib/sync/trunk.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/sync/fetch.ts src/lib/sync/trunk.ts src/lib/sync/fetch.test.ts src/lib/sync/trunk.test.ts
git commit -m "feat(sync): implement fetch and trunk sync phases"
```

### Task 5: Implement cleanup phase for merged/closed branches

**Files:**
- Create: `src/lib/sync/cleanup.ts`
- Test: `src/lib/sync/cleanup.test.ts`

**Step 1: Write failing tests for cleanable vs non-cleanable branches**

Include:
- cleanable merged branch gets deleted,
- non-cleanable merged branch prints warning and excludes descendants,
- force bypasses prompts,
- non-interactive skip behavior.

**Step 2: Run targeted tests**

Run: `pnpm test src/lib/sync/cleanup.test.ts`
Expected: FAIL.

**Step 3: Implement cleanup phase**

Add `runCleanupPhase(ctx, prInfos)` to:
- compute cleanable sets,
- execute deletion decisions,
- return branch exclusions.

**Step 4: Re-run targeted tests**

Run: `pnpm test src/lib/sync/cleanup.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/sync/cleanup.ts src/lib/sync/cleanup.test.ts
git commit -m "feat(sync): add merged/closed branch cleanup phase"
```

### Task 6: Implement branch sync status classifier

**Files:**
- Create: `src/lib/sync/branch-status.ts`
- Test: `src/lib/sync/branch-status.test.ts`

**Step 1: Write failing matrix tests for all statuses**

Cover status families:
- `missing-remote`, `missing-local`, `untracked`, `unsubmitted`,
- `up-to-date`, `updated-outside-dubstack-but-up-to-date`,
- `new-parent-with-remote-change`, `reconcile-needed`,
- `needs-remote-sync-safe`, `needs-remote-sync`.

**Step 2: Run targeted tests**

Run: `pnpm test src/lib/sync/branch-status.test.ts`
Expected: FAIL.

**Step 3: Implement classifier**

Add pure classifier:
```ts
classifyBranchSyncStatus(input): BranchSyncStatusResult
```

**Step 4: Re-run targeted tests**

Run: `pnpm test src/lib/sync/branch-status.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/sync/branch-status.ts src/lib/sync/branch-status.test.ts
git commit -m "feat(sync): add branch sync status classifier"
```

### Task 7: Implement reconciliation decision engine (interactive + force)

**Files:**
- Create: `src/lib/sync/reconcile.ts`
- Test: `src/lib/sync/reconcile.test.ts`

**Step 1: Write failing tests for decision tree**

Cover:
- force paths,
- non-interactive conservative skips,
- interactive choices for keep-local/take-remote/reconcile/reconcile-alt/cancel.

**Step 2: Run targeted tests**

Run: `pnpm test src/lib/sync/reconcile.test.ts`
Expected: FAIL.

**Step 3: Implement decision engine**

Add:
- `decideForStatus(ctx, branchStatus)`
- prompt adapter with explicit choice mapping.

**Step 4: Re-run targeted tests**

Run: `pnpm test src/lib/sync/reconcile.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/sync/reconcile.ts src/lib/sync/reconcile.test.ts
git commit -m "feat(sync): implement interactive reconciliation decision engine"
```

### Task 8: Implement sync apply engine for decisions

**Files:**
- Create: `src/lib/sync/apply.ts`
- Test: `src/lib/sync/apply.test.ts`

**Step 1: Write failing tests for decision application**

Cover:
- `take-remote` (reset/recreate local state),
- `keep-local-baseline-update`,
- `reconcile` and `reconcile-alt-parent`,
- metadata updates after success.

**Step 2: Run targeted tests**

Run: `pnpm test src/lib/sync/apply.test.ts`
Expected: FAIL.

**Step 3: Implement apply engine**

Add functions:
- `applySyncDecision(ctx, decision)`
- `updateBranchSyncMetadata(...)`

**Step 4: Re-run targeted tests**

Run: `pnpm test src/lib/sync/apply.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/sync/apply.ts src/lib/sync/apply.test.ts
git commit -m "feat(sync): implement branch sync apply operations"
```

### Task 9: Add sync reporting and user-output summaries

**Files:**
- Create: `src/lib/sync/report.ts`
- Test: `src/lib/sync/report.test.ts`

**Step 1: Write failing tests for stable text output**

Test phase headings, warnings, and final summary counts.

**Step 2: Run targeted tests**

Run: `pnpm test src/lib/sync/report.test.ts`
Expected: FAIL.

**Step 3: Implement report module**

Add helpers:
- `printPhaseStart(...)`
- `printBranchOutcome(...)`
- `printSyncSummary(...)`

**Step 4: Re-run targeted tests**

Run: `pnpm test src/lib/sync/report.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/sync/report.ts src/lib/sync/report.test.ts
git commit -m "feat(sync): add sync reporting and summaries"
```

### Task 10: Wire `dub sync` command and CLI options

**Files:**
- Create: `src/commands/sync.ts`
- Modify: `src/index.ts`
- Test: `src/commands/sync.test.ts`

**Step 1: Write failing command tests**

Cover:
- default options,
- `--no-restack`, `--force`, `--all`, `--no-interactive`,
- pipeline invocation order,
- error surfacing.

**Step 2: Run targeted tests**

Run: `pnpm test src/commands/sync.test.ts`
Expected: FAIL.

**Step 3: Implement command orchestrator and CLI wiring**

In `src/index.ts`, add:
```ts
program
  .command("sync")
  .description("Sync stack branches with remote and reconcile divergence")
  .option("--restack", "Restack after sync", true)
  .option("-f, --force", "Apply forced overwrite/deletion decisions")
  .option("-a, --all", "Sync branches across all tracked trunks")
  .option("--no-interactive", "Disable prompts and use deterministic behavior")
  .action(runSync);
```

**Step 4: Re-run targeted tests**

Run: `pnpm test src/commands/sync.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/commands/sync.ts src/index.ts src/commands/sync.test.ts
git commit -m "feat(sync): add dub sync command orchestration"
```

### Task 11: Integrate optional post-sync restack behavior

**Files:**
- Modify: `src/commands/sync.ts`
- Modify: `src/lib/sync/types.ts`
- Test: `src/commands/sync.test.ts`

**Step 1: Write failing tests for restack behavior gates**

- restack runs by default,
- skipped with `--no-restack`,
- restack warnings surfaced without masking sync success.

**Step 2: Run targeted tests**

Run: `pnpm test src/commands/sync.test.ts`
Expected: FAIL.

**Step 3: Implement restack integration**

Hook into existing restack command/module, scoped to synchronized trunks/stack roots.

**Step 4: Re-run targeted tests**

Run: `pnpm test src/commands/sync.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/commands/sync.ts src/lib/sync/types.ts src/commands/sync.test.ts
git commit -m "feat(sync): integrate optional post-sync restack phase"
```

### Task 12: Update docs for user-facing sync behavior

**Files:**
- Modify: `README.md`
- Modify: `QUICKSTART.md`

**Step 1: Add failing doc expectation check (optional lightweight)**

If doc tests exist, run them first; otherwise skip this step.

**Step 2: Update docs**

Document:
- command usage and flags,
- interactive decision points,
- non-interactive behavior,
- force safety caveats,
- common troubleshooting paths.

**Step 3: Verify docs formatting**

Run: `pnpm checks`
Expected: PASS.

**Step 4: Commit**

```bash
git add README.md QUICKSTART.md
git commit -m "docs(sync): document dub sync behavior and troubleshooting"
```

### Task 13: Full verification and stabilization

**Files:**
- Modify (as needed): any failing files from verification

**Step 1: Run full test suite**

Run: `pnpm test`
Expected: PASS.

**Step 2: Run type checks**

Run: `pnpm typecheck`
Expected: PASS.

**Step 3: Run formatting/lint checks**

Run: `pnpm checks`
Expected: PASS.

**Step 4: Fix any failures minimally**

Apply focused fixes only where needed; rerun failing command(s).

**Step 5: Final commit**

```bash
git add -A
git commit -m "feat(sync): complete full parity sync command"
```
