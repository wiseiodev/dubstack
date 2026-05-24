## TL;DR

Adds lib/checkout-history.ts (ring buffer maxSize=20, atomic write-rename, transient filter) and threads appendCheckoutHistory through every HEAD-mutating command: checkout/navigate/create (user-initiated) and post-merge/restack/sync/submit-refresh (transient).

## Why

DUB-38 (`dub back`) needs a chronological record of branches HEAD has visited. Today nothing writes one — checkoutBranch fires and the previous branch is lost.

Internal restores (sync's restoreTarget, post-merge's checkout(root), restack's final checkout) move HEAD too, but should not appear in `dub back` as a navigable target. The lib needs an opt-out signal.

### Before

- .git/dubstack/checkout-history.json does not exist.
- dub co, dub checkout, dub up/down/top/bottom, and dub create change HEAD with no persisted trail.
- Internal HEAD restores in sync, post-merge, restack, and the shared submitRefreshedStacks helper move HEAD without distinction from user navigation.

### After

- Every HEAD-mutating checkout writes a {branch, at, via, transient?} entry to a 20-slot ring buffer at .git/dubstack/checkout-history.json.
- User-initiated checkouts (checkout, up, down, top, bottom, create) record with transient: false; internal restores (post-merge, restack, sync, submit-refresh) record with transient: true.
- readCheckoutHistory(cwd) defaults to filtering out transient entries; DUB-38 can read this directly.

## File-by-file

### packages/cli/src/lib/checkout-history.ts

new +118 / -0

Core lib. Exports CheckoutEntry, appendCheckoutHistory, readCheckoutHistory, clearCheckoutHistory, getCheckoutHistoryPath. Ring buffer at maxSize=20, atomic write via temp file + rename, internal try/catch swallows I/O errors so a transient disk problem cannot break a checkout that already succeeded. transient flag is stored but stripped from the default read.

```typescript
export async function appendCheckoutHistory(
  cwd: string,
  branch: string,
  opts: { via: string; transient?: boolean },
): Promise<void> {
  try {
    const entries = await readStored(cwd);
    const entry: StoredCheckoutEntry = {
      branch,
      at: new Date().toISOString(),
      via: opts.via,
    };
    if (opts.transient) entry.transient = true;
    entries.push(entry);
    const trimmed =
      entries.length > MAX_SIZE ? entries.slice(-MAX_SIZE) : entries;
    await writeStored(cwd, trimmed);
  } catch {
    // best-effort; never let history failures break a checkout
  }
}
```

### packages/cli/src/lib/checkout-history.test.ts

new +132 / -0

10 unit tests covering append + newest-first read, default empty result, transient filter, ring eviction at 20, custom limit, zero/negative limit, clear, corrupt-JSON tolerance, no temp files left behind, and transient entries consuming ring slots.

### packages/cli/src/commands/checkout.ts

mod +2 / -0

After checkoutBranch in `checkout()` (the single funnel for `dub co`, `dub checkout <branch>`, and `dub checkout --trunk`), appendCheckoutHistory(cwd, name, { via: 'checkout' }).

```typescript
await checkoutBranch(name, cwd);
await appendCheckoutHistory(cwd, name, { via: 'checkout' });
```

### packages/cli/src/commands/navigate.ts

mod +5 / -0

Four wire points — up/down/top/bottom — each tagged with its own `via` so the future `dub back` UI can show navigation provenance.

```typescript
await checkoutBranch(target, cwd);
await appendCheckoutHistory(cwd, target, { via: 'up' });
```

### packages/cli/src/commands/create.ts

mod +2 / -0

After createBranch (which uses `git checkout -b` and so changes HEAD), record the new branch with via: 'create'. This also covers `dub flow`, which composes create + submit.

```typescript
await createBranch(branchName, cwd);
await appendCheckoutHistory(cwd, branchName, { via: 'create' });
```

### packages/cli/src/commands/post-merge.ts

mod +13 / -0

Three internal HEAD restores wired as transient: true — checkout(root) before restack, and the two checkout(preferredBranch) destinations after the cleanup + submit pass.

```typescript
await checkoutBranch(root, cwd);
await appendCheckoutHistory(cwd, root, {
  via: 'post-merge',
  transient: true,
});
```

### packages/cli/src/commands/restack.ts

mod +5 / -0

After the final restoration to progress.originalBranch, record via: 'restack', transient: true so the temporary moves restack does mid-rebase do not pollute `dub back`.

```typescript
await checkoutBranch(progress.originalBranch, cwd);
await appendCheckoutHistory(cwd, progress.originalBranch, {
  via: 'restack',
  transient: true,
});
```

### packages/cli/src/commands/sync.ts

mod +19 / -1

Four wire points, all transient: the fallback checkout during squash-merged cleanup, the per-root checkout before restack, the preferredBranch checkout before submit refresh, and the final restoreTarget at the end of sync. All carry via: 'sync'.

```typescript
await checkoutBranch(restoreTarget, cwd);
await appendCheckoutHistory(cwd, restoreTarget, {
  via: 'sync',
  transient: true,
});
```

### packages/cli/src/commands/stack-maintenance.ts

mod +5 / -0

Adversarial-review catch: submitRefreshedStacks (called from both post-merge and sync to refresh PRs after cleanup) calls checkoutBranch in a loop without going through the command-level wire points. Wired here with via: 'submit-refresh', transient: true so the per-stack HEAD moves don't surface in `dub back`.

```typescript
await checkoutBranch(branchName, cwd);
await appendCheckoutHistory(cwd, branchName, {
  via: 'submit-refresh',
  transient: true,
});
```

### .reports/dub-83-qa.md

new +103 / -0

Self-QA fallback (no .tsx changed, no UI surface). Documents the acceptance-criteria mapping, the call-site inventory, and the green gate output.

## Where to focus review

1. **Best-effort error swallow in appendCheckoutHistory** - `packages/cli/src/lib/checkout-history.ts (appendCheckoutHistory)`: The first draft let writeStored throw. That caused sync's existing try/catch around checkoutBranch + restoreTarget to swallow the history error and re-throw a misleading 'could not restore branch' DubError, breaking three unrelated sync tests. The fix is an internal try/catch in appendCheckoutHistory — the auxiliary log can never break the underlying checkout. Reviewers should confirm this trade-off (silent failure vs. surfacing disk problems) is acceptable for a sidecar log.
2. **Transient flag plumbing at every internal restore** - `packages/cli/src/commands/{post-merge,restack,sync,stack-maintenance}.ts`: Every checkoutBranch in these four files is wired as transient: true. If any are missed, `dub back` (DUB-38) will offer the user a restore target that was never user-meaningful. The adversarial reviewer caught stack-maintenance.ts:106 on the first pass; reviewers should confirm no other internal-restore call site escaped.
3. **Out-of-scope commands left unwired** - `packages/cli/src/commands/{undo,delete}.ts and lib/restack-rollback.ts`: undo, delete, and restack-rollback also call checkoutBranch but were not listed in the DUB-83 spec. They are left unwired by design. If DUB-38 wants to surface undo restores, that wiring can be added then. Confirm this scoping aligns with the product intent for `dub back`.

## Test plan

- [x] **unit:** checkout-history.test.ts (10 tests) — append, read, default-empty, transient filter, ring eviction at 20, custom limit, zero/negative limit, clear, corrupt-JSON tolerance, no temp leftover - src/lib/checkout-history.test.ts (10 tests) 822ms — all passed.
- [x] **unit:** Full CLI suite — verifies no regression in the six modified commands - Test Files 98 passed (98); Tests 924 passed (924).
- [x] **build:** pnpm typecheck - Tasks: 2 successful, 2 total.
- [x] **build:** pnpm checks (biome incl. lint plugins) - Checked 301 files in 957ms. No fixes applied.

## Quality gates

- **Vitest suite:** `pnpm vitest run (in packages/cli)` - passed (924 tests passed across 98 files; new file contributes 10 tests.)
- **TypeScript:** `pnpm typecheck` - passed (Tasks: 2 successful, 2 total.)
- **Biome check (incl. Tier 3 lint plugins):** `pnpm checks` - passed (Checked 301 files in 957ms. No fixes applied.)

## Self-QA

See [QA fallback evidence](.reports/dub-83-qa.md).

Self-QA fallback: acceptance criteria mapping, call-site inventory, and green gate output documented in .reports/dub-83-qa.md.

- Append three entries with different `via` values — readCheckoutHistory returns them newest-first.
- Append 25 entries — read returns the most-recent 20; the oldest 5 are dropped silently.
- Append a mix of transient and non-transient entries — default read filters out the transient ones.
- Corrupt the JSON file on disk — read returns []; subsequent append succeeds and rewrites the file.

## Acceptance criteria

- [x] lib/checkout-history.ts exists with appendCheckoutHistory, readCheckoutHistory, clearCheckoutHistory - packages/cli/src/lib/checkout-history.ts — three exported functions matching the issue signatures, plus the CheckoutEntry interface.
- [x] Ring buffer at maxSize = 20 - MAX_SIZE = 20 constant; the 'enforces a ring buffer of size 20' unit test verifies 25 inserts yield 20 entries with the oldest 5 dropped.
- [x] All HEAD-changing commands call appendCheckoutHistory - checkout.ts, navigate.ts (×4), create.ts, post-merge.ts (×3), restack.ts, sync.ts (×4), stack-maintenance.ts (×1) — every checkoutBranch in the scope of the issue has a paired appendCheckoutHistory.
- [x] transient: true entries are filtered from default reads - readCheckoutHistory filters !entry.transient; verified by two unit tests including a worst-case where 20 transient entries precede a single visible one.
- [x] Atomic write-rename for the JSON - writeStored writes to `${target}.${pid}.${ts}.tmp` and renames; on rename failure the temp is unlinked. Verified by the 'writes atomically and leaves no temp files behind' unit test.
- [x] Tests cover append, read, filter, ring eviction, transient filter - checkout-history.test.ts has dedicated tests for each of those five behaviors plus four additional edge cases (empty, custom limit, clear, corrupt-JSON tolerance).
- [x] No regression in existing tests for modified commands - Full CLI suite green: Test Files 98 passed (98); Tests 924 passed (924).

## Adversarial review

Iterations: 1

Remaining critical/major: 0/0

Remaining minor/nitpick: 0/0

- Reviewer flagged stack-maintenance.ts:105 (submitRefreshedStacks) as an unwired checkoutBranch reachable from both post-merge and sync. Fixed by adding appendCheckoutHistory(cwd, branchName, { via: 'submit-refresh', transient: true }) after the checkout.
- Reviewer noted undo.ts and delete.ts also call checkoutBranch but are not listed in the issue spec. Confirmed scope-out is intentional and called out in `reviewFocus` for future DUB-38 follow-up.

## Dependencies

- **No external dependencies detected:** n/a

## Rollout

Pure additive infrastructure. The new lib only writes; no consumer reads from it yet. End-user UX is unchanged until DUB-38 (`dub back`) ships and starts consuming readCheckoutHistory.

- **On merge - Background recording begins:** Every HEAD-mutating command starts appending to .git/dubstack/checkout-history.json. No user-visible change.
- **When DUB-38 lands - dub back goes live:** dub back calls readCheckoutHistory(cwd) and shows the most recent non-transient entries as restore targets.
- **When DUB-60 (lockfile) lands - Concurrency hardening:** Step 5 of the issue calls for routing writes through the optimistic-concurrency lockfile. Tracked as future work — atomic write-rename is sufficient until then.

## Commit

```text
feat(checkout-history): ring-buffer infrastructure for dub back [DUB-83]
```
