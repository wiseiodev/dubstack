# Self-QA fallback - DUB-22

> This work item has no useful browser recording surface, so this file replaces
> the video and records deterministic proof instead.

## Why no video

DUB-22 is a pure CLI logic change in `packages/cli/src/commands/merge-next.ts`
(and its CLI wiring in `packages/cli/src/index.ts`). Exercising it end-to-end
requires a real GitHub PR tree with mixed mergeability statuses, which is not
reproducible inside this workspace. There is no UI to record.

## What was verified

1. `pnpm checks` (biome lint + format) — 246 files clean, no fixes applied.
2. `pnpm typecheck` (tsc --noEmit across docs + dubstack) — clean.
3. `pnpm test` — full repo suite passes (694 tests, 84 files).
4. `pnpm test -- merge-next` — focused suite, 11 tests, all green. New tree-
   selection cases assert:
   - 3-sibling tree, current branch wins, other mergeable peers reported as
     `siblingCandidates`.
   - 3-sibling tree from off-stack branch picks the alphabetically first child
     of trunk.
   - Linear parent → grandchild stack picks the depth-1 parent without probing
     the grandchild's mergeability.
   - Mixed mergeable+BLOCKED siblings: hint excludes the blocked branch.
   - BLOCKED-only depth-1 candidate throws `DubError` with PR number,
     mergeable, and mergeStateStatus inlined; `mergePr`/`retargetPrBase` are
     never called.
   - Blocked depth-1 with a mergeable grandchild still errors — confirms we
     do not descend past a blocked floor.
   - Dry-run reflects the chosen target and sibling hint without mutation.
   - Existing pre-merge child-PR retarget + `postMerge` orchestration still
     fire in the correct order.
5. Adversarial review (single iteration via feature-dev:code-reviewer): one
   critical finding ("descent past blocked floor is theoretically possible
   even if the eligibility guard masks it today") was addressed by replacing
   `continue` with `break` when the lowest non-empty depth has no MERGEABLE
   candidate. A regression test pins the contract. One important finding
   ("blocked siblings could leak into the hint list") was addressed by a new
   test that asserts exclusion.

## Evidence

- Commit: `73c5778` — `feat(merge-next): tree-aware target with mergeability check`
- Files touched (3): `packages/cli/src/commands/merge-next.ts`,
  `packages/cli/src/commands/merge-next.test.ts`, `packages/cli/src/index.ts`.
- Test command transcript: `pnpm test` → `84 passed (84) / 694 passed (694)`
  at `08:06:42`.
- Lint command transcript: `pnpm checks` → `Checked 246 files in 50ms. No fixes applied.`
- Typecheck transcript: `pnpm typecheck` → `2 successful, 2 total`.

## Follow-up flag

None. The new selection path uses the existing `getAllPrSyncInfoBatch`
truncation fallback already covered by `lib/github.ts`, so behavior on stacks
with > 100 lifetime PRs degrades gracefully through `getBranchPrSyncInfo`.
