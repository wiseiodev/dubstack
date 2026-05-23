## TL;DR

lib/git.ts:hasUniquePatchCommits collapsed empty `git cherry` stdout to 'no unique commits = equivalent', the same bug class Graphite hit in v1.7.18. The helper now requires SHA equality or `headRef`-reachable-from-`baseRef` before treating empty output as equivalence; otherwise it fails open ('has unique') so callers do not silently drop local work. New regression test in git.cherry-empty.test.ts fails on the pre-guard implementation.

## Why

Audit the four named files for any place that decides 'matches / doesn't match' from a git command's stdout.

Eliminate the specific class of bug where an empty output is treated as 'equivalent' without a positive confirming signal.

Lock the behavior in with a regression test so the bug cannot reappear.

### Before

- hasUniquePatchCommits(baseRef, headRef) split cherry stdout, trimmed, and returned `lines.some(startsWith('+'))`.
- Empty stdout → empty array → some() returns false → caller (restack.ts:204) interprets as 'no unique commits' and SKIPS the rebase.
- If `git cherry` ever produced empty output for a non-equivalent pair (the Graphite bug pattern: obscure git config, commit-msg encoding edge case, etc.), local commits would be silently dropped without any visible signal.

### After

- Non-empty cherry output: behavior unchanged — same `.some(startsWith('+'))` decision.
- Empty cherry output: helper requires a positive equivalence signal — SHA equality OR `headRef` is an ancestor of `baseRef`. If either holds, it returns false (no unique). If neither holds, it returns true (has unique) so callers do not silently discard local work.
- Failure of the confirming check (e.g., one of the refs cannot be resolved) collapses to 'not confirmed', which again returns true — always the safe direction.

## File-by-file

### packages/cli/src/lib/git.ts

mod +37 / -7

Restructured hasUniquePatchCommits so that empty `git cherry` stdout goes through isPatchEquivalenceConfirmed (SHA equality + ancestor check) instead of collapsing to false. Non-empty path is unchanged. Added a JSDoc note tying the guard to the Graphite v1.7.18 bug class.

```ts
if (lines.length === 0) {
  return !(await isPatchEquivalenceConfirmed(baseRef, headRef, cwd));
}
return lines.some((line) => line.startsWith('+'));
```

### packages/cli/src/lib/git.cherry-empty.test.ts

new +108 / -0

Vitest regression suite that mocks execa to simulate the three empty-output situations. Test 1 fails on the pre-guard implementation: empty cherry + differing SHAs + head not ancestor of base must return true. Tests 2 and 3 confirm the legitimate equivalence paths (same SHA, head ancestor of base) still return false.

```ts
it('reports unique commits when cherry is empty but SHAs differ (guard)', async () => {
  // empty cherry, distinct SHAs, head NOT an ancestor of base
  await expect(hasUniquePatchCommits('main', 'feat', '/repo')).resolves.toBe(true);
});
```

### .reports/dub-19-qa.md

new +52 / -0

Self-QA fallback markdown — non-browser change so no Playwright video. Contains the per-site audit table for the four files in scope, the guard description, and the scenarios exercised by the automated suite.

## Where to focus review

1. **Audit completeness** - `packages/cli/src/lib/sync/branch-status.ts, packages/cli/src/lib/sync/cleanup.ts, packages/cli/src/commands/sync.ts, packages/cli/src/lib/git.ts`: The audit table in .reports/dub-19-qa.md walks every match-decision site in the four files named by the issue. hasUniquePatchCommits is the only one that consumed empty stdout as a match signal; the rest already use positive signals (SHA equality, ancestor exit code, rebase success). Confirm nothing was missed.
2. **Direction of the ancestor check** - `packages/cli/src/lib/git.ts:isPatchEquivalenceConfirmed`: Empty `git cherry baseRef headRef` means `rev-list baseRef..headRef` is empty, which happens when headRef is reachable from baseRef (or head == base). The guard therefore calls `isAncestor(headRef, baseRef)`. Verify the direction matches the cherry semantics — flipping it would invert the guard.
3. **Fail-open semantics** - `packages/cli/src/lib/git.ts:hasUniquePatchCommits`: When the confirming check throws (refs missing, transient git failure), the catch returns false → outer `!` flips to true → 'has unique'. This is intentional: erroneously running a rebase is recoverable; silently skipping one is not. Confirm this matches the project's preferred error stance.
4. **Caller behavior change** - `packages/cli/src/commands/restack.ts:204`: restack.ts:204 still treats `!hasUniquePatches` as 'skip the rebase'. The guard now produces fewer false 'no unique' results, so previously-skipped branches in the bug case will rebase instead. The happy paths (squash-merged children, truly unique commits) remain identical.

## Test plan

- [x] **unit:** Empty cherry + differing SHAs + head not ancestor of base → has unique (guard) - packages/cli/src/lib/git.cherry-empty.test.ts — fails without the guard, passes with it.
- [x] **unit:** Empty cherry + identical SHAs → no unique - packages/cli/src/lib/git.cherry-empty.test.ts — exercises the SHA-equality confirmation branch.
- [x] **unit:** Empty cherry + head ancestor of base → no unique - packages/cli/src/lib/git.cherry-empty.test.ts — exercises the isAncestor confirmation branch.
- [x] **integration:** Happy paths in git.test.ts continue to pass - Existing fixture tests 'returns true when a branch has unique work' and 'returns false when squash-merged upstream' produce non-empty cherry output and are unaffected by the guard.

## Quality gates

- **lint:** `pnpm checks` - passed (biome check . — 222 files, no fixes applied.)
- **typecheck:** `pnpm typecheck` - passed (tsc --noEmit across docs + dubstack — 0 errors.)
- **tests:** `pnpm test` - passed (vitest — 76 files, 642 tests pass (3 new for DUB-19).)

## Self-QA

See [QA fallback evidence](.reports/dub-19-qa.md).

Self-QA fallback markdown — audit table covering every match-decision site in the four files named by the issue, plus the regression scenarios exercised by the automated suite.

- Empty cherry + SHAs differ + head not ancestor of base → guard returns has unique (regression).
- Empty cherry + same SHA → returns no unique (legitimate equivalence).
- Empty cherry + head ancestor of base → returns no unique (legitimate equivalence).
- Non-empty cherry output (squash-merged child, truly unique commits) → unchanged behavior, existing fixture tests still pass.

## Acceptance criteria

- [x] Audit complete; documented in PR description which 'match' decisions were reviewed. - Full audit table in .reports/dub-19-qa.md covering all 9 match-decision sites across the four files named by the issue.
- [x] Every match-decision site verified to require a positive signal beyond empty output. - 8 of 9 sites already used positive signals (SHA equality, ancestor exit code, rebase/FF success). The lone vulnerable site, hasUniquePatchCommits, now requires SHA equality or ancestor confirmation before trusting empty output.
- [x] New regression test that fails without the guard and passes with it. - packages/cli/src/lib/git.cherry-empty.test.ts — primary test asserts has-unique=true for empty cherry + differing SHAs, which the pre-guard implementation could not produce (empty array → some() === false).
- [x] No behavior change for the happy path. - Non-empty cherry output flows through the identical `.some(startsWith('+'))` logic. All 642 existing tests pass.

## Adversarial review

Iterations: 1

Remaining critical/major: 0/0

Remaining minor/nitpick: 0/0

- Confirmed happy path unchanged: filtering empty lines from cherry stdout does not affect .some(startsWith('+')) because empty strings do not start with '+'.
- Confirmed isAncestor direction matches `git cherry baseRef headRef` semantics — empty output ⟺ headRef reachable from baseRef.
- Confirmed fail-open semantics: helper exceptions in the confirmation path collapse to 'not confirmed' → 'has unique', which is the safe direction (rebase instead of silent skip).
- No other callers of hasUniquePatchCommits beyond restack.ts:204; behavior change there is from a false 'no unique' to a correct 'has unique', which triggers a rebase that should have run.

## Dependencies

- **DUB-14 (sync status taxonomy + reconciliation source tags):** merged in commit 3e15a44 prior to this branch; no runtime coupling beyond shared use of lib/git.ts.

## Rollout

Safe to merge once review approves. Pure additive guard inside a library helper; no migrations, flags, or staged rollout needed.

- **On merge - Ship:** Squash-merge into main. The guard activates immediately for every `dub sync` and `dub restack` invocation; the worst-case happy-path effect is one extra `git rev-parse` + `git merge-base --is-ancestor` only when `git cherry` returns empty stdout.
- **Post-merge - Monitor:** If `dub restack` starts attempting rebases that previously silently skipped, that is the guard catching the bug case (or a fixture quirk) — investigate the affected branch, not the guard.

## Commit

```text
fix(sync): guard hasUniquePatchCommits against empty-cherry false equivalence [DUB-19]
```
