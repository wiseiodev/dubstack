# Self-QA fallback - DUB-21

> This work item has no useful browser recording surface, so this file replaces
> the video and records deterministic proof instead.

## Why no video

DUB-21 is pure CLI library code: it changes `packages/cli/src/lib/pr-body.ts`
(tree rendering + metadata schema) and `packages/cli/src/commands/submit.ts`
(caller wiring). No `.tsx` files changed; nothing renders in a browser. The
exercise of the changed code is rendering Markdown/HTML strings that GitHub
later displays — verified via inline snapshot assertions in
`pr-body.test.ts`.

## What was verified

1. `pnpm checks` (biome lint + format) — passes clean.
2. `pnpm typecheck` (tsc --noEmit across the workspace) — passes clean.
3. `pnpm test` (vitest, all packages) — 696/696 tests pass, including:
   - 26 tests in `pr-body.test.ts` (3 new snapshots: 3-sibling tree, 5-deep
     linear stack, >40-branch truncation; legacy→v1 metadata migration test;
     unknown `schema_version` rejection).
   - The pre-existing `submit-tree` integration tests still pass with the new
     caller wiring.
4. Adversarial review run on the staged diff before commit; both findings
   (sibling PRs missing PR numbers in tree table; meaningless `prev_pr`/
   `next_pr` for tree siblings) were fixed and the resulting diff re-verified.

## Evidence

- Inline snapshots in `packages/cli/src/lib/pr-body.test.ts`:
  - `renders a 3-sibling tree with alphabetical sibling order` (the exact tree
    from the issue spec — `feat/auth-base` with three sorted children, 👈 on
    `feat/auth-login`).
  - `renders a 5-deep linear stack`.
  - `truncates stacks larger than 40 branches` and `shows hidden-count summary
    when siblings have hidden descendants`.
- `migrates a legacy (pre-v1) metadata block to v1 with empty tree fields` —
  proves backwards compatibility for PR bodies written by older `dub submit`.
- `merge-check.ts` consumer of `parseDubstackMetadata` re-checked: it only
  reads `prev_pr`, which is now correctly derived from the parent branch
  rather than positional BFS order, so merge gating for siblings is no longer
  spuriously blocked.

## Follow-up flag

None. The work is self-contained inside `pr-body.ts` and one caller. The PR
body format change is backwards-compatible: old metadata blocks continue to
parse, and the new tree table is rendered atomically on the next `dub submit`.
