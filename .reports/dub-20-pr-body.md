## TL;DR

Drops the submit branching-blocker rejection, sorts siblings deterministically, keeps --fix as a deprecated no-op, and adds a 3-sibling tree integration test.

## Why

Tier 1 — Branching Stack Support depends on submit walking trees instead of rejecting them.

doctor was duplicating the same blocker as a user-visible issue, which would have outlived the submit rejection if not removed together.

### Before

- dub submit --path stack threw 'Branching stacks are not supported by submit' on any tree.
- dub doctor surfaced a submit-branching-blocker issue for tree stacks, contradicting the new design.
- topologicalOrder preserved insertion order for siblings, so sibling order was non-deterministic across runs.

### After

- dub submit --path stack walks tree stacks natively in BFS order (parent first, siblings sorted by branch name).
- dub doctor no longer reports submit-branching-blocker; the issue code is removed from DoctorIssueCode.
- --fix prints a one-line deprecation warning and otherwise behaves identically, so existing scripts keep working.

## File-by-file

### packages/cli/src/commands/submit.ts

mod +10 / -82

Removes SubmitBranchingBlocker, findBranchingBlockers, buildBranchingError, fallbackApplied, and the blocker throw in getSubmitPlan. Adds a deprecation log line when --fix is passed. SubmitPlan/SubmitResult shed the fallbackApplied field.

```ts
if (options.fix) {
  console.log(
    "⚠ '--fix' is deprecated and is now a no-op; submit handles branching stacks natively.",
  );
}
```

### packages/cli/src/commands/doctor.ts

mod +0 / -41

Drops 'submit-branching-blocker' from DoctorIssueCode, removes the blocker loop in doctor(), and deletes the local findBranchingBlockers helper. doctor no longer flags tree stacks as unhealthy.

### packages/cli/src/lib/state.ts

mod +5 / -1

topologicalOrder now sorts each parent's children alphabetically before BFS enqueue so submit/restack walk trees deterministically.

```ts
for (const children of childMap.values()) {
  children.sort((a, b) => a.name.localeCompare(b.name));
}
```

### packages/cli/src/index.ts

mod +3 / -3

Updates --fix option text to '[deprecated] No-op alias kept for script compatibility' on both submit and ss aliases; rewrites the stale example referencing 'safe auto-remediation'.

### packages/cli/test/commands/submit-tree.test.ts

new +98 / -0

New integration test: 3-sibling tree (main → feat/alpha, feat/bravo, feat/charlie). Asserts deterministic ordering, parent-first BFS, --path current isolation, and that the legacy branching-blocker error is no longer thrown.

### packages/cli/src/commands/submit.test.ts

mod +12 / -18

Replaces the 'throws when stack has branching children' and 'falls back with --fix' assertions with positive tree-submit coverage and a --fix deprecation-warning assertion.

### packages/cli/src/commands/doctor.test.ts

mod +3 / -5

Swaps the 'detects submit branching blockers' case for a positive 'does not flag branching stacks' assertion.

### packages/cli/src/commands/flow.test.ts

mod +0 / -2

Drops obsolete fallbackApplied: false fields from SubmitResult mocks.

### packages/cli/src/commands/merge-next.test.ts

mod +0 / -1

Drops obsolete fallbackApplied: false from SubmitResult mock.

### packages/cli/src/commands/post-merge.test.ts

mod +0 / -3

Drops obsolete fallbackApplied: false from SubmitResult mocks.

### packages/cli/src/commands/ready.test.ts

mod +0 / -2

Drops obsolete fallbackApplied: false from SubmitResult mocks.

### packages/cli/src/commands/sync.test.ts

mod +0 / -3

Drops obsolete fallbackApplied: false from SubmitResult mocks.

### packages/cli/test/commands/flow.test.ts

mod +0 / -1

Drops obsolete fallbackApplied: false from SubmitResult mock.

### .reports/dub-20-qa.md

new +64 / -0

Self-QA fallback: explains why no video, what was verified per AC, and pastes the real CLI smoke transcript.

## Where to focus review

1. **getSubmitPlan no longer rejects tree stacks** - `packages/cli/src/commands/submit.ts (getSubmitPlan)`: Confirm the function returns branches from topologicalOrder(stack) directly for --path stack and exposes no remaining blocker-throwing branch.
2. **Deterministic sibling order via topologicalOrder** - `packages/cli/src/lib/state.ts:topologicalOrder`: New alphabetical sort runs once per parent's children. Confirm restack and stack-maintenance, which share this helper, do not depend on prior insertion order semantics.
3. **doctor no longer emits submit-branching-blocker** - `packages/cli/src/commands/doctor.ts (DoctorIssueCode + doctor body)`: Verify the union literal is gone, the local helper is removed, and no other doctor branch produces the obsolete code.
4. **--fix preserved as deprecated no-op** - `packages/cli/src/index.ts (submit + ss option) and packages/cli/src/commands/submit.ts (deprecation log)`: Existing scripts must still parse --fix without error; the option text and submit() warning should make the deprecation explicit.

## Test plan

- [x] **unit:** submit.test.ts and doctor.test.ts updates - vitest run as part of pnpm test (84 files / 689 tests passing) — includes tree-submit, --fix deprecation, and the new doctor 'does not flag branching stacks' case.
- [x] **integration:** submit-tree.test.ts (3-sibling tree) - vitest 'submit tree integration' run inside pnpm test (3 tests passing).
- [x] **manual:** CLI smoke: tree stack submit + --fix deprecation - .reports/dub-20-qa.md contains the full real-CLI transcript (dub init, three siblings, dub log, dub doctor --no-fetch, dub submit --path stack --dry-run, dub submit --path stack --fix --dry-run).

## Quality gates

- **Lint + format:** `pnpm checks` - passed (biome check . → 244 files, 0 errors.)
- **Typecheck:** `pnpm typecheck` - passed (turbo run typecheck → 2 packages successful (dubstack + docs).)
- **Tests:** `pnpm test` - passed (vitest → 84 files, 689 tests passing including new submit-tree integration test.)

## Self-QA

See [QA fallback evidence](.reports/dub-20-qa.md).

CLI smoke transcript and per-AC verification in lieu of video.

- dub submit --path stack on a 3-sibling tree (parent + alpha/bravo/charlie) succeeds in dry-run with parent-first BFS ordering.
- dub submit --path stack --fix prints the deprecation warning and otherwise behaves identically.
- dub doctor --no-fetch on the same tree no longer surfaces submit-branching-blocker.

## Acceptance criteria

- [x] findBranchingBlockers and buildBranchingError removed from submit.ts - submit.ts diff removes both helpers and the SubmitBranchingBlocker interface; rg in packages/cli/src confirms no remaining references.
- [x] dub submit --path stack succeeds on a stack with a parent that has 2+ children - submit-tree.test.ts 'plans submit for a 3-sibling tree' + real CLI smoke transcript in qa file.
- [x] PR creation order: parent PR exists before child PR; sibling order deterministic by branch name - topologicalOrder now sorts children alphabetically; integration test asserts feat/alpha → feat/bravo → feat/charlie after randomized insertion.
- [x] All child PRs have the correct --base - submit() loop uses const base = branch.parent as string and calls createPr(branch.name, base, ...). Smoke output shows feat/alpha→main, feat/bravo→main, feat/charlie→main.
- [x] Existing --path current behavior unchanged - getCurrentPathBranches untouched. submit-tree.test.ts 'limits --path current to the linear path even when siblings exist' pins it. Prior --path current tests still pass.
- [x] --fix becomes a no-op with deprecation warning - submit.ts emits the deprecation log when options.fix is true; submit.test.ts 'treats --fix as a deprecated no-op alias' asserts both the warning and the success path. CLI smoke captured the warning.
- [x] doctor no longer reports submit-branching-blocker - DoctorIssueCode removed the union member; doctor.test.ts 'does not flag branching stacks as a doctor issue' asserts result.healthy === true on a tree stack.
- [x] New integration test in packages/cli/test/commands/: 3-sibling tree submit - packages/cli/test/commands/submit-tree.test.ts (3 cases) checked into this commit.
- [x] submit.test.ts updated; branching-blocker assertions deleted - Removed 'throws when stack has branching children' and the --fix-fallback case; replaced with positive tree + deprecated --fix cases.

## Adversarial review

Iterations: 1

Remaining critical/major: 0/0

Remaining minor/nitpick: 1/0

- Reviewer flagged a stale help-text fragment '--path stack --fix Submit full stack with safe auto-remediation' — resolved by updating both --fix option descriptions and the example in index.ts.

## Dependencies

- **Linear blockers / dependencies on DUB-20:** None — issue description states 'Blocked by: None — can start immediately.' Restack tree coverage is tracked separately as DUB-76 and intentionally out of scope here.

## Rollout

Standard merge to main. No data migration, no flag, no env change. --fix scripts keep working but will emit one deprecation line per invocation.

- **merge - Land PR:** Squash-merge once CI is green; CLI ships in the next dub release.
- **next-major - Remove --fix:** Track a future major version (out of scope here) to drop the deprecated --fix alias entirely.

## Commit

```text
feat(submit): walk tree-shaped stacks without rejection [DUB-20]
```
