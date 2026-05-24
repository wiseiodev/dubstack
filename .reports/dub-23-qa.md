# Self-QA fallback - DUB-23

> This work item has no useful browser recording surface, so this file replaces
> the video and records deterministic proof instead.

## Why no video

DUB-23 is a test-only addition: a new vitest spec at
`packages/cli/test/commands/post-merge-tree.test.ts` that covers tree-shaped
`post-merge` scenarios via mocks. There is no CLI command surface or UI
output that changed — `post-merge.ts` was not touched because the existing
algorithm (`getMergedBottomBranches`, `removeBranchFromStack`,
`retargetOpenPrBranches`, `submitRefreshedStacks`) already handles trees per
the DUB-23 verification notes.

## What was verified

1. `pnpm checks` (biome lint + format) — 257 files clean, no fixes applied.
2. `pnpm typecheck` (tsc --noEmit across docs + dubstack) — clean.
3. `pnpm test` — full repo suite passes: 86 files, 768 tests
   (was 761 before; +7 new). No regressions in linear-stack `post-merge.test.ts`.
4. `pnpm vitest run test/commands/post-merge-tree.test.ts` — focused suite,
   7 tests, all green. Each scenario asserts the four DUB-23 acceptance
   contracts simultaneously:
   - **S1 — leaf merged.** Sibling parent unchanged, no reparent, no
     `retargetPrBase` call.
   - **S2 — middle merged, single child.** Child reparented to grandparent
     (`main`), `gh pr edit --base main` invoked exactly once for the child.
   - **S3 — middle merged, multiple children.** All three children reparented
     to `main` in one cleanup pass; each child PR retargeted to `main`.
   - **S4 — base merged with multi-sibling subtree.** Two siblings reparent to
     `main`; their grandchildren keep their original parents (sib-a/sib-b)
     and their PRs are NOT retargeted — proves the retarget set is scoped to
     branches whose parent actually moved.
   - **S5 — cascade.** Base + middle both MERGED in one pass; the surviving
     leaf and sibling both end up parented on `main` after both deletions;
     both PRs retargeted.
   - **PR body refresh.** With default `submit: true`, the post-cleanup
     `submit(cwd, false, { stack: true })` is invoked. Invocation order
     asserted: every `retargetPrBase` fires before `submit`, so PR bases
     are correct when `updateAllPrBodies` rewrites the tree-shaped stack
     table (DUB-21 schema).
   - **Surviving-descendant checkout.** When the user is on the merged
     branch, `checkoutBranch('feat/leaf', '/repo')` is invoked so the
     terminal lands on a real branch after cleanup.

## Evidence

- New file: `packages/cli/test/commands/post-merge-tree.test.ts` (377 lines).
- Test command transcript: `pnpm test` → `86 passed (86) / 768 passed (768)`
  at `11:09:44`, Duration 7.39s.
- Lint command transcript: `pnpm checks` → `Checked 257 files in 37ms. No fixes applied.`
- Typecheck transcript: `pnpm typecheck` → `2 successful, 2 total` (docs + dubstack).
- No production code changed; `packages/cli/src/commands/post-merge.ts` is
  unmodified (DUB-23 is verification + coverage only).

## Follow-up flag

None. The "cleanup journal unification" follow-up that the DUB-23 description
mentions is already tracked as DUB-76/DUB-77 and is out of scope.
