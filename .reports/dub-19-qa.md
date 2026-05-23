# DUB-19 Self-QA (non-browser fallback)

This is a CLI library change inside `packages/cli/src/lib/git.ts`. No TSX or browser surface was modified, so Playwright video is not required. QA evidence below is the local automated test suite plus the audit summary.

## Why no video

The change touches a pure helper (`hasUniquePatchCommits`). It has no UI surface and no observable user interaction beyond `dub restack` and `dub sync` behavior that is already covered by integration tests in the suite.

## Automated suite

- `pnpm checks` (biome) — passes.
- `pnpm typecheck` — passes.
- `pnpm test` — 642 tests pass across 76 files. 3 tests added for DUB-19 in `packages/cli/src/lib/git.cherry-empty.test.ts`.

## Audit summary — match-decision sites

Walked every match/no-match decision in the four files named by the issue:

| Site | Source | Match signal | Empty-output safe? |
|---|---|---|---|
| `branch-status.ts:44` | `localSha === remoteSha` | Positive SHA equality on two separately-fetched refs. | ✅ Yes — both SHAs must be non-null and equal. |
| `cleanup.ts` | `prState === 'MERGED' \| 'CLOSED'` + `isAncestor`/`isMergedByPatchId` | PR enum + ancestor exit code (0/1). | ✅ Yes — no string-empty trap. |
| `sync.ts` — `localBehind` / `remoteBehind` | `isAncestor` exit code | Exit code 0 = ancestor, 1 = not. | ✅ Yes. |
| `sync.ts` — reconcile path | `rebaseBranchOntoRef` return value | Rebase success/failure. | ✅ Yes. |
| `git.ts:isAncestor` | `git merge-base --is-ancestor` exit code | Exit code. | ✅ Yes. |
| `git.ts:fastForwardBranchToRef` | `git merge --ff-only` | Command success vs. fast-forward conflict string. | ✅ Yes. |
| `git.ts:rebaseBranchOntoRef` | `git rebase <ref>` | Command success. | ✅ Yes. |
| `git.ts:isWorkingTreeClean` | `git status --porcelain` empty | Documented git contract; not a branch-vs-branch decision. | ✅ Yes (out of scope). |
| `git.ts:hasUniquePatchCommits` | `git cherry baseRef headRef` | `.some(line.startsWith('+'))` over the parsed lines | ⚠️ **Was vulnerable.** Empty stdout collapsed to `false` (= "no unique commits = equivalent"), which is the exact Graphite v1.7.18 bug class. **Now guarded.** |
| `git/is-merged-by-patch-id.ts` | `git cherry` per commit | `firstLine?.startsWith('-')` — advances `currentBase` only on a clear `-` line. | ✅ Yes — empty output does NOT advance, so the walk only reports "merged" when every commit produced a positive `-` signal. |

Caller `commands/restack.ts:204` consumed `hasUniquePatchCommits` and would have silently skipped a rebase on a false negative. Centralizing the guard inside the helper fixes both the direct caller and any future caller.

## Guard added

`lib/git.ts:hasUniquePatchCommits` — when `git cherry` returns empty stdout, the helper now requires a positive equivalence confirmation (SHA equality OR `headRef` reachable from `baseRef`) before reporting "no unique commits." Otherwise it returns `true` ("has unique") so callers do not silently discard local work.

## Scenarios exercised by automated tests

1. **Regression — empty cherry + differing SHAs + head NOT ancestor of base** → guard returns `true` (has unique). Without the guard, `[].some(...) === false` would have caused a sync/restack to drop local work. This test fails on the pre-guard implementation.
2. **Empty cherry + same SHA** → returns `false` (no unique). Sanity case for the positive SHA-equality confirmation path.
3. **Empty cherry + head ancestor of base** → returns `false` (no unique). Legitimate "head already contained in base" equivalence path.
4. **Existing fixture tests** in `git.test.ts` (`hasUniquePatchCommits returns true when a branch has unique work` and `returns false when squash-merged upstream`) continue to pass — happy paths untouched.

## Manual smoke (optional)

- `dub restack` against a stack where a child branch has commits and the parent has been re-tipped without merging the child — the rebase still runs (the helper's guard is irrelevant here; this just confirms no regression on the happy path).
- `dub restack` against a squash-merged child — the helper returns `false` from a non-empty cherry result (`-` lines for the patch-equivalent commits), and restack skips it. Unchanged.

## Follow-up flag

None. The change is local to a single helper and is fully covered by deterministic tests.
