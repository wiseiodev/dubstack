# Self-QA fallback - DUB-75

> This work item has no useful browser recording surface, so this file replaces
> the video and records deterministic proof instead.

## Why no video

DUB-75 is purely a CLI test-coverage + bug-fix issue. There is no UI, no .tsx
file changed, and no browser-demoable surface. The deliverable is a new vitest
file that exercises `dub restack` on tree-shaped stacks plus a one-spot
`writeState` fix in `packages/cli/src/commands/restack.ts`.

## What was verified

- All 6 acceptance-criteria scenarios pass:
  1. Trunk → base → {a,b,c}: trunk advances, base + siblings cascade onto new parents; `parent_revision` updated on every node and no commit duplication.
  2. Restack invoked from a non-root sibling (`feat/b`) walks the entire tree containing it in BFS order — `feat/a`, `feat/b`, `feat/c`, then `feat/a1`.
  3. Sibling conflict + `dub continue`: `feat/b` conflicts on `conflict.txt`; `feat/a` was already rebased (and persisted — see fix below); after resolving and continuing, `feat/c` also rebases. Final `parent_revision` for all three siblings equals new main tip.
  4. Sibling already squash-merged into base is skipped via `hasUniquePatchCommits`; remaining sibling still rebases onto new base.
  5. Sibling checked out in another worktree is skipped with the `formatWorktreeCheckoutSkipMessage` log line; other siblings continue to rebase.
  6. Restack invoked from the trunk (root) covers all descendants in BFS order.

- **Bug surfaced and fixed.** Scenario 3 initially failed: when an earlier
  sibling rebased successfully but a later sibling conflicted, the in-memory
  `state` mutation for the successful sibling was discarded — `writeState`
  only ran at the very end of `executeRestackSteps`. After `dub continue`
  resumed, the previously-done sibling's `parent_revision` still pointed at
  the stale parent tip. Fix: persist `state` immediately after each successful
  rebase and after each "parent didn't move" skip, both inside
  `executeRestackSteps` in `packages/cli/src/commands/restack.ts`.

- Full repo gates pass:
  - `pnpm checks` (biome lint + format): clean
  - `pnpm typecheck`: clean
  - `pnpm test`: 695/695 passing (84 pre-existing + 6 new = 90 in restack-adjacent files; full suite green)

## Evidence

- New test file: `packages/cli/test/commands/restack-tree.test.ts` (6 scenarios, ~300 LOC)
- Source fix: `packages/cli/src/commands/restack.ts` (+6 lines, two `await writeState(state, cwd);` calls in `executeRestackSteps`)
- Test run output: `pnpm test` → "Test Files 85 passed (85) / Tests 695 passed (695)"

## Follow-up flag

None. The `writeState` fix is purely additive — it persists the same `state`
object that was already being written at the end of `executeRestackSteps`,
just earlier in the loop so a later conflict cannot discard it. No existing
restack test changed behavior.

## Review iterations

- **Self-review pass 2 (commit 02b273b):** strict adversarial review surfaced
  comment / dedup nits — replaced inline `getBranch` loop with the existing
  `findStackForBranch` helper, clarified BFS-with-alpha-sort comment, fixed
  misleading "replayed" wording on the continue path, added a matching
  why-comment on the skip-path `writeState`.
- **Copilot review (commit 8f87afe):** flagged ordering concern between
  `writeProgress` and `writeState` — a `writeState` failure after
  `writeProgress` would leave the step marked done in progress with stale
  `parent_revision` on disk, and `restack --continue` would skip the
  already-done step (the original DUB-75 bug in a different shape). Swapped
  both paths to write state first, then mark progress.
