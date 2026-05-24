# Self-QA fallback - DUB-78

> This work item has no useful browser recording surface, so this file replaces
> the video and records deterministic proof instead.

## Why no video

DUB-78 is a CLI-only change (no `.tsx` files modified, no browser-demoable
surface). The affected user-visible surfaces are `dub merge-check --scope` and
`dub ready --scope` — both terminal output and verified through unit tests
against tree-shaped stack fixtures plus a real CLI smoke run of the new flag.

## What was verified

1. **`--scope <mode>` parsed on both commands.** Smoke against the new build:
   ```
   $ node packages/cli/dist/index.js ready --help | grep -A1 scope
       --scope <mode>  Validation scope: current | downstack (default) | stack (default: "downstack")
   $ node packages/cli/dist/index.js merge-check --help | grep -A1 scope
       --scope <mode>  Validation scope when no --pr/--branch is given:
                       current (default) | downstack | stack (default: "current")
   ```
2. **Tree-shaped stacks succeed (AC1).** `merge-check.test.ts` "scope walks
   every non-root branch including siblings" exercises a 3-sibling tree
   (`main → feat/a → {feat/b1, feat/b2, feat/b3}`) end-to-end through the
   real `resolveScopeBranches` + `topologicalOrder` BFS (the state mock was
   updated to keep `topologicalOrder` un-mocked so the actual scope-walking
   path is verified, not bypassed).
3. **`--scope <mode>` works on both commands (AC2).**
   - `ready.test.ts` covers `current`, `downstack`, `stack` and asserts the
     correct `path` is forwarded to `getSubmitPlan` (`current` → `path:
     'current'`, `stack` → `path: 'stack'`).
   - `merge-check.test.ts` covers all three scopes plus the explicit
     `--branch` override path.
4. **Tests for each scope on a 3-sibling tree (AC3).** `scope.test.ts` pins
   `resolveScopeBranches` against the exact tree fixture from the issue
   (3 siblings under one parent); `merge-check.test.ts` exercises the same
   tree through the public command surface; `ready.test.ts` exercises each
   scope's branch list shape.
5. **No regression on existing linear-stack tests (AC4).** Original
   single-PR `mergeCheck` tests retained verbatim; original `ready` tests
   retained and pass (`scope: 'downstack'` defaults preserve the prior
   `path: 'current'` submit-plan behavior).
6. **Per-branch finding aggregation when multiple branches fail.** New
   test "aggregates per-branch findings when multiple branches in scope
   fail" asserts the `3 of 4 branch(es) cannot merge yet:` aggregate
   summary. Single-failure-in-scope case throws the original DubError
   shape unchanged (preserves recovery hints — addressed in adversarial
   review round).
7. **CLI output for multi-branch findings.** When `result.branches.length
   > 1`, the CLI prints one line per branch with PR number + reason
   (`index.ts:759–773`).

## Evidence

- `pnpm checks` → clean (248 files, 0 errors).
- `pnpm typecheck` → 2 packages cached, passing.
- `pnpm test` → 85 files, 704 tests passing (includes 7 new `scope.test.ts`
  tests, 5 new `merge-check.test.ts` tree-scope tests, 3 new `ready.test.ts`
  scope tests).
- Adversarial review: one critical finding addressed (single-failure error
  shape preserved across scope sizes); one important finding addressed
  (docstring contract on `resolveScopeBranches` corrected for `stack` scope
  ignoring `currentBranch`); one important finding addressed (test no
  longer mocks `topologicalOrder`, so real BFS is exercised).

## Follow-up flag

None within scope. The submit-side `SubmitPathMode = 'current' | 'stack'`
still uses two-value vocabulary while ready/merge-check use the
three-value scope vocabulary; left alone deliberately to avoid scope
creep into `submit.ts` which DUB-20 just landed.
