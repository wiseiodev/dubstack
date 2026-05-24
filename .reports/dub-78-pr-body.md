## TL;DR

Adds `--scope <current|downstack|stack>` to dub merge-check and dub ready, a shared resolveScopeBranches helper, and tree-fixture tests covering all three scopes plus multi-branch failure aggregation.

## Why

Tier 1 — Branching Stack Support: now that submit walks trees natively (DUB-20), merge-check and ready must follow so the full mergeability story works on trees.

Without scope semantics, running merge-check on a branch with siblings silently ignored those siblings even though they need merging in stack order too.

### Before

- dub merge-check only ever inspected the current branch's PR (or an explicit --pr).
- dub ready called getSubmitPlan({ path: 'current' }) with no way to widen to siblings.
- There was no shared vocabulary for 'current branch + ancestors' vs 'whole stack' across commands.

### After

- dub merge-check --scope downstack|stack walks multiple branches and prints per-branch findings; --pr/--branch keep their single-PR semantics.
- dub ready --scope <mode> selects the validation breadth; default is downstack (current + ancestors), matching the issue recommendation.
- Shared lib/scope.ts (ScopeMode + parseScope + resolveScopeBranches) gives future commands one helper for tree-aware scoping.

## File-by-file

### packages/cli/src/lib/scope.ts

new +73 / -0

New helper: ScopeMode union, parseScope (DubError with recovery hints on bad input), and resolveScopeBranches which returns the branch list anchored on currentBranch for current/downstack and falls back to topologicalOrder(stack) BFS for stack. Root branches are always filtered out.

```ts
export type ScopeMode = 'current' | 'downstack' | 'stack';

export function resolveScopeBranches(
  stack: Stack,
  currentBranch: string,
  scope: ScopeMode,
): Branch[] {
  if (scope === 'stack') {
    return topologicalOrder(stack).filter((b) => b.type !== 'root');
  }
  // ... current + downstack walk via parent chain
}
```

### packages/cli/src/lib/scope.test.ts

new +78 / -0

Unit coverage for parseScope (accepts the three values, throws DubError otherwise) and resolveScopeBranches (3-sibling tree fixture: main → feat/a → {feat/b1, feat/b2, feat/b3}). Covers root-branch and missing-branch edge cases.

### packages/cli/src/commands/merge-check.ts

mod +144 / -14

Refactor: extracts checkPrFinding (returns a per-branch finding instead of throwing) and throwIfAnyFailed (preserves single-PR DubError shape when exactly one branch fails — regardless of how many were inspected — and aggregates otherwise). New options.scope path walks resolveScopeBranches over the current stack when no --pr/--branch is given.

```ts
if (failed.length === 1) {
  const [only] = failed;
  if (!only) return;
  throw new DubError(only.reason, only.fixes);
}
```

### packages/cli/src/commands/merge-check.test.ts

mod +152 / -17

Existing single-PR throw assertions retained verbatim. Adds a tree-shaped fixture (3 siblings) and five new tests: downstack scope walks current+ancestors; stack scope walks every non-root branch (real topologicalOrder via vi.importActual — no longer mocked); current scope checks only the current branch; --branch overrides scope walking; multi-branch failure aggregates the summary message.

### packages/cli/src/commands/ready.ts

mod +22 / -4

Accepts options.scope (default downstack). Maps scope=stack to getSubmitPlan({ path: 'stack' }) and scope=current to a single-branch slice of the plan; downstack preserves the prior getSubmitPlan({ path: 'current' }) behavior. Result type adds scope + submitPath fields.

```ts
const planPath: SubmitPathMode = scope === 'stack' ? 'stack' : 'current';
const plan = await getSubmitPlan(cwd, { path: planPath });
submitBranches =
  scope === 'current'
    ? planBranches.filter((name) => name === plan.currentBranch)
    : planBranches;
```

### packages/cli/src/commands/ready.test.ts

mod +75 / -0

Existing tests preserved. Adds three scope tests on a 3-sibling tree: downstack returns current + ancestors and forwards { path: 'current' }; current narrows to just the current branch; stack returns every non-root branch and forwards { path: 'stack' }.

### packages/cli/src/index.ts

mod +65 / -4

CLI wiring: imports parseScope/ScopeMode; adds --scope option to ready (default downstack) and merge-check (default current; --pr forces single-PR mode), each with addHelpText examples. merge-check now prints one line per branch when result.branches.length > 1.

### README.md

mod +20 / -4

Updates the dub ready and dub merge-check sections with the new --scope flag, default values, and usage examples.

### apps/docs/content/docs/commands/doctor.mdx

mod +14 / -3

Mirrors the README updates in the docs site so the rendered command reference shows the --scope examples for ready and merge-check.

## Where to focus review

1. **throwIfAnyFailed preserves single-PR DubError shape** - `packages/cli/src/commands/merge-check.ts (throwIfAnyFailed)`: Adversarial review caught that the original check only preserved the per-finding fixes when findings.length === 1. The current implementation triggers on failed.length === 1 instead, so a single failing branch inside a multi-branch scope still throws DubError(reason, fixes) with the correct recovery hints rather than the aggregated summary.
2. **resolveScopeBranches contract for scope=stack** - `packages/cli/src/lib/scope.ts:resolveScopeBranches`: scope=stack ignores currentBranch by design (every non-root branch is returned). Confirm the JSDoc clearly states this so future callers don't pass a stray currentBranch expecting an anchor.
3. **Real topologicalOrder exercised by merge-check tree tests** - `packages/cli/src/commands/merge-check.test.ts (vi.mock '../lib/state.js')`: Uses vi.importActual to keep topologicalOrder un-mocked so the BFS sibling sort runs for real. Verify the mock surface only stubs readState + findStackForBranch.
4. **Default scope choice on each command** - `packages/cli/src/index.ts (ready and merge-check definitions)`: ready defaults to downstack (matches issue recommendation; preserves prior submit-plan path); merge-check defaults to current (preserves the prior single-PR check semantics for the CLI default invocation). Confirm both defaults are explicit in the help text.

## Test plan

- [x] **unit:** scope.test.ts (parseScope + resolveScopeBranches) - vitest src/lib/scope.test.ts → 7 tests passing; covers each scope on a 3-sibling tree plus root/missing-branch edge cases.
- [x] **unit:** ready.test.ts scope coverage - vitest src/commands/ready.test.ts → 6 tests passing (3 original + 3 new scope tests asserting forwarded submit path).
- [x] **unit:** merge-check.test.ts tree scope coverage - vitest src/commands/merge-check.test.ts → 10 tests passing (5 original single-PR + 5 new tree-scope tests including multi-branch aggregation).
- [x] **manual:** CLI smoke: --scope visible in --help on both commands - Captured in .reports/dub-78-qa.md: ready --help and merge-check --help both show the new --scope option with the correct default.

## Quality gates

- **Lint + format:** `pnpm checks` - passed (biome check . → 248 files, 0 errors.)
- **Typecheck:** `pnpm typecheck` - passed (turbo run typecheck → 2 packages successful (dubstack + docs).)
- **Tests:** `pnpm test` - passed (vitest → 85 files, 704 tests passing including the new scope, ready, and merge-check tree coverage.)

## Self-QA

See [QA fallback evidence](.reports/dub-78-qa.md).

CLI smoke transcript and per-AC verification in lieu of video.

- dub merge-check --scope stack on a 3-sibling tree iterates every non-root branch and aggregates per-branch findings.
- dub ready --scope downstack returns current + ancestors and forwards { path: 'current' } to getSubmitPlan; --scope stack forwards { path: 'stack' }.
- dub merge-check default (--scope current, no --pr/--branch) preserves the prior single-PR error message + recovery fixes.

## Acceptance criteria

- [x] dub merge-check and dub ready succeed (no blocker error) on tree-shaped stacks after DUB-20 lands - DUB-20 already landed (commit 86303e2); merge-check.test.ts 'stack scope walks every non-root branch including siblings' and ready.test.ts 'stack scope checks every branch in the stack' both pass on the 3-sibling fixture without any branching-blocker error.
- [x] --scope <mode> flag works on both commands - ready.test.ts asserts the correct submit-plan path is forwarded for each scope; merge-check.test.ts asserts the right branches are walked for each scope; CLI --help output confirmed in qa fallback.
- [x] Tests for each scope on a 3-sibling tree - scope.test.ts uses main → feat/a → {feat/b1, feat/b2, feat/b3} and pins each scope; merge-check.test.ts and ready.test.ts reuse the same shape through the public command surface.
- [x] No regression on existing linear-stack tests - All 5 original single-PR merge-check tests and all 3 original ready tests retained and pass unchanged; total suite 704/704.

## Adversarial review

Iterations: 1

Remaining critical/major: 0/0

Remaining minor/nitpick: 1/0

- Critical (resolved): throwIfAnyFailed silently swapped error format when a single failure occurred in a multi-branch scope, stripping per-finding fixes from the thrown DubError. Loosened the guard to failed.length === 1 so the original DubError(reason, fixes) shape is preserved regardless of scope size.
- Important (resolved): resolveScopeBranches JSDoc claimed an empty list for missing currentBranch in all scopes, but scope=stack ignores currentBranch entirely. Docstring rewritten to make the per-scope contract explicit.
- Important (resolved): merge-check.test.ts mocked topologicalOrder, so the scope-walk ordering assertions relied on a pre-sorted mock return rather than the real BFS. Switched to vi.importActual so the real topologicalOrder runs; the tree tests now exercise the actual scope-walking code path.

## Dependencies

- **DUB-20 (Tree-walking submit) — Linear blocker:** Merged: commit 86303e2 'feat(submit): walk tree-shaped stacks without rejection [DUB-20] (#53)'. With the branching-blocker rejection gone, merge-check/ready can now walk trees freely.

## Rollout

Standard merge to main. No data migration, no flag, no env change. The new --scope option is purely additive; existing dub ready and dub merge-check invocations keep working (ready's default matches the previous implicit submit-plan path; merge-check's default remains the single-PR check).

- **merge - Land PR:** Squash-merge once CI is green; CLI ships in the next dub release.
- **post-merge - Verify downstream commands unaffected:** merge-next and post-merge consume mergeCheck/ready outputs; the result type only adds fields (scope, branches), so existing consumers keep working without changes.

## Commit

```text
feat(merge-check,ready): tree-aware --scope flag [DUB-78]
```
