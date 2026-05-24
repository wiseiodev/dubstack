# Self-QA fallback - DUB-20

> This work item has no useful browser recording surface, so this file replaces
> the video and records deterministic proof instead.

## Why no video

DUB-20 is a CLI-only change (no `.tsx` files modified, no browser-demoable
surface). The affected user-visible surfaces are `dub submit`, `dub doctor`,
and stack metadata ordering — all terminal output verified via a real CLI
smoke run plus unit + integration tests.

## What was verified

1. **Tree-shaped stack accepted by `submit --path stack` (AC1, AC2).**
   Real CLI smoke against a fresh repo with a tree (main → feat/alpha,
   feat/bravo, feat/charlie):
   ```
   Submitting 3 branch(es) from 'feat/alpha' onto trunk 'main'.
   [dry-run] would push feat/alpha
   [dry-run] would push feat/bravo
   [dry-run] would push feat/charlie
   [dry-run] would check/create PR: feat/alpha → main
   [dry-run] would check/create PR: feat/bravo → main
   [dry-run] would check/create PR: feat/charlie → main
   ✔ Dry-run complete (stack path): would push 3 branch(es) and check/create 3 PR(s).
   ```
2. **Parent first, deterministic sibling order (AC3, AC4).** `topologicalOrder`
   now sorts siblings by branch name; smoke output emits alpha → bravo →
   charlie. Each child PR targets `main` as `--base`. Asserted in the new
   `submit-tree.test.ts` integration test.
3. **`--path current` unchanged (AC5).** `submit-tree.test.ts` "limits
   --path current to the linear path even when siblings exist" pins this.
4. **`--fix` becomes a no-op with deprecation warning (AC6).** Smoke output:
   ```
   ⚠ '--fix' is deprecated and is now a no-op; submit handles branching stacks natively.
   ```
   Unit test `treats --fix as a deprecated no-op alias` in `submit.test.ts`
   pins the warning + the no-op behavior.
5. **`doctor` no longer reports `submit-branching-blocker` (AC7).** Smoke
   `dub doctor --no-fetch` on the tree stack reports only `missing-remote`
   issues (expected — no remote configured). The `submit-branching-blocker`
   code is removed from `DoctorIssueCode`; replacement test
   `does not flag branching stacks as a doctor issue` pins it.
6. **New integration test (AC8).** `packages/cli/test/commands/submit-tree.test.ts`
   covers the 3-sibling tree submit, deterministic ordering, and `--path current`
   isolation.
7. **`submit.test.ts` updated (AC9).** Branching-blocker assertions deleted;
   replaced with tree-submit + `--fix` deprecation assertions.

## Evidence

- `pnpm checks` → clean (244 files, 0 errors).
- `pnpm typecheck` → 2 packages passing.
- `pnpm test` → 84 files, 689 tests passing (includes new tree-submit
  integration test and updated submit/doctor unit tests).
- Smoke transcript captured above (real `dub init`, real branches, real
  `dub submit --dry-run`, real `dub doctor --no-fetch`).

## Follow-up flag

None within scope. DUB-76 still tracks the explicit restack-over-tree test
coverage gap referenced by the DUB-20 description; this PR intentionally
leaves that out of scope.
