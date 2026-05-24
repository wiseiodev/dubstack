## TL;DR

PR bodies now render the stack as a tree (2-space indent per level, siblings alphabetical, 👈 on current). Hidden metadata is bumped to v1 and includes parent/children/siblings plus a flat tree array; legacy blocks are migrated to v1 at parse time. Submit now derives prev/next from actual parent/single-child relationships and pulls PR numbers from persisted state so siblings submitted earlier still render with their #N in the tree.

## Why

Tier 1 branching-stack support: the flat list lost sibling information once stacks became trees, so reviewers couldn't see the shape of the work landing alongside their PR.

Downstream consumers (the action webhook tracked in DUB-71) need a versioned, tree-aware metadata block they can rebuild the stack from without reading repo state — DUB-71's parser concern is satisfied by the v1 schema this PR introduces.

merge-check.ts was using positional BFS to infer prev_pr, which made independent siblings spuriously block each other once submit started walking trees.

### Before

- buildStackTable produced `- #N title` for every non-root branch in submission order, with no visual distinction between parent/child/sibling.
- DubstackMetadata stored only stack_id, pr_number, prev_pr, next_pr, branch — no schema_version, no way to express siblings or tree shape.
- submit.ts iterated `plan.branches` (no root) and computed prev/next positionally, so submitting `feat/bravo` next to a previously-submitted sibling `feat/alpha` rendered `feat/alpha` as a bare branch name and pointed prev_pr at the wrong PR.

### After

- buildStackTable renders the stack as an indented tree from the root, siblings alphabetical, 👈 preserved, with deterministic truncation past 40 branches (current + ancestors + their direct children + descendants).
- DubstackMetadata is `schema_version: 1` and carries parent (string|null), children (string[]), siblings (string[]), and tree ({name, depth, pr_number?, is_current?}[]). parseDubstackMetadata accepts both old and v1 shapes and emits v1 in either case.
- submit walks the full stack for table/metadata construction, pulls PR numbers for prior-run siblings from Branch.pr_number, sets prev_pr from the actual parent's PR, and only sets next_pr when the branch has exactly one child.

## File-by-file

### packages/cli/src/lib/pr-body.ts

mod +307 / -0

New DubstackMetadata v1 interface and DubstackMetadataTreeNode; buildStackTable now builds a tree from parent links, sorts siblings alphabetically, applies the >40-branch truncation rule with a hidden-branch summary line, and preserves the 👈 marker. buildMetadataBlock takes a structured DubstackMetadata input and serializes the v1 shape. New buildMetadataTree emits the flat depth-tagged tree for the metadata block. parseDubstackMetadata accepts both legacy (no schema_version) and v1 shapes — legacy is migrated to v1 with empty tree/siblings/children/parent so consumers always see the v1 surface, and unknown schema_version values are rejected.

```ts
export function buildStackTable(
  branches: Branch[],
  prMap: Map<string, StackEntry>,
  currentBranch: string,
): string {
  const root = buildTree(branches);
  const truncate = branches.length > TRUNCATION_THRESHOLD;
  // ...renders indented tree with truncation summary...
}
```

### packages/cli/src/commands/submit.ts

mod +87 / -0

updateAllPrBodies now receives the full stack (plan.stack.branches) alongside the current-path branches it iterates. The PR-table lookup falls back to Branch.pr_number from persisted state so siblings submitted in prior runs still render with their #N. prev_pr is derived from the actual parent's table entry; next_pr is only set when the branch has exactly one child (linear continuation). children/siblings on the metadata block are derived from the stack's parent map and sorted alphabetically for deterministic output.

```ts
for (const branch of stackBranches) {
  const pr = prMap.get(branch.name);
  if (pr) {
    tableEntries.set(branch.name, { number: pr.number, title: pr.title });
  } else if (branch.pr_number != null) {
    tableEntries.set(branch.name, {
      number: branch.pr_number,
      title: branch.name,
    });
  }
}
```

### packages/cli/src/lib/pr-body.test.ts

mod +286 / -0

Updated existing tests to assert the tree shape and added inline-snapshot tests for the three required tree shapes from the issue spec (3-sibling, 5-deep, large+truncated). New tests cover legacy→v1 metadata migration, unknown-schema_version rejection, and the buildMetadataTree depth+is_current output.

```ts
expect(result).toMatchInlineSnapshot(`
  "<!-- dubstack:start -->\n---\n### 🥞 DubStack\n- main\n  - #100 feat/auth-base\n    - #101 feat/auth-login 👈\n    - #102 feat/auth-signup\n    - #103 feat/auth-tests\n<!-- dubstack:end -->"
`);
```

### .reports/dub-21-qa.md

new +49 / -0

Fallback self-QA artifact: the work is CLI library code with no .tsx changes, so deterministic snapshot tests + lint + typecheck + 696/696 vitest pass replace a browser video.

## Where to focus review

1. **Truncation visible-set semantics** - `packages/cli/src/lib/pr-body.ts (computeVisibleNames)`: Only stacks with >40 branches truncate. The visible set is current + ancestor chain + each ancestor's direct children + all descendants of current — i.e. siblings and aunts/uncles are kept, but deeper niece/nephew subtrees collapse into the hidden-count line. The test `shows hidden-count summary when siblings have hidden descendants` pins this behavior; flagged for any sharper semantic concerns.
2. **Legacy metadata migration** - `packages/cli/src/lib/pr-body.ts (parseDubstackMetadata)`: PR bodies written before this PR have no schema_version and lack parent/children/siblings/tree. The parser accepts them and emits v1 with empty tree fields, which keeps merge-check.ts working on existing PRs. Worth confirming the validation predicate matches the legacy fields the wild PRs actually have.
3. **prev_pr / next_pr semantics for trees** - `packages/cli/src/commands/submit.ts (updateAllPrBodies)`: prev_pr is now derived from the actual parent branch's PR rather than positional BFS order; next_pr is null when the branch has more than one child. This is intentional and stops merge-check.ts from gating sibling merges on each other, but it's a behavioral change worth scrutinizing for any downstream that relied on the BFS-positional meaning.

## Test plan

- [x] **unit:** Tree shape + truncation + legacy migration in pr-body.test.ts - 26/26 in pr-body.test.ts including inline snapshots for 3-sibling, 5-deep, and >40-branch truncation.
- [x] **integration:** submit-tree integration still walks trees correctly - test/commands/submit-tree.test.ts continues to pass with the new caller wiring (full stack + per-branch metadata).
- [x] **build:** biome lint + format - pnpm checks → 246 files checked, no errors.
- [x] **build:** tsc --noEmit across workspace - pnpm typecheck passes for dubstack and docs apps.

## Quality gates

- **Lint + format:** `pnpm checks` - passed (Checked 246 files in 78ms. No fixes applied.)
- **Typecheck:** `pnpm typecheck` - passed (Tasks: 2 successful, 2 total (dubstack + docs).)
- **Tests:** `pnpm test` - passed (Test Files 84 passed (84); Tests 696 passed (696).)

## Self-QA

See [QA fallback evidence](.reports/dub-21-qa.md).

Deterministic proof in lieu of video: inline snapshot tests for the three required tree shapes, legacy metadata migration test, plus full pnpm checks/typecheck/test pass.

- 3-sibling tree (the exact example from the DUB-21 spec) with 👈 on the middle sibling.
- 5-deep linear stack — verifies depth indentation past three levels.
- Stack of 41 sibling subtrees — verifies the >40 truncation rule with the hidden-count summary line.
- Legacy (pre-v1) metadata block parses to v1 with empty tree fields.

## Acceptance criteria

- [x] buildStackTable renders tree shape correctly - Inline snapshot in `renders a 3-sibling tree with alphabetical sibling order` matches the issue spec example byte-for-byte.
- [x] Sibling order alphabetical - buildTree() sorts childMap entries with localeCompare; covered by the 3-sibling and large-stack snapshots.
- [x] 👈 marker preserved - renderNodeLabel appends ' 👈' iff branch.name === currentBranch; asserted in the marks-correct-branch test and the snapshots.
- [x] Truncation rule applied for stacks > 40 branches - TRUNCATION_THRESHOLD = 40; computeVisibleNames builds the visible set (current + ancestors + each ancestor's direct children + descendants of current); hidden-count summary line tagged at the bottom. Covered by `truncates stacks larger than 40 branches` and `shows hidden-count summary when siblings have hidden descendants`.
- [x] buildMetadataBlock writes all v1 fields including tree - buildMetadataBlock takes a structured DubstackMetadata and serializes it; `serializes a v1 metadata block` asserts schema_version/parent/siblings/tree/is_current are all present.
- [x] parseDubstackMetadata accepts old and v1 metadata blocks - `parses a v1 metadata block from a composed PR body` and `migrates a legacy (pre-v1) metadata block to v1 with empty tree fields` both pass; unknown schema_version values are rejected by `returns null when schema_version is unknown`.
- [x] Snapshot tests for several tree shapes (3-sibling, 5-deep, large+truncated) - Three new inline snapshots in pr-body.test.ts cover exactly these shapes.
- [x] pr-body.test.ts updated; flat-list assertions migrated - Existing buildStackTable tests now assert the indented tree form (e.g. `  - #101 feat: api`, `    - #102 feat: ui 👈`); root is included via a helper `root('main')` in the new fixtures.

## Adversarial review

Iterations: 1

Remaining critical/major: 0/0

Remaining minor/nitpick: 0/0

- Fixed (critical): In updateAllPrBodies, the PR-number lookup was only populated from this run's prMap, so siblings submitted in prior runs rendered as bare branch names in the tree table. Fixed by falling back to Branch.pr_number from persisted state.
- Fixed (major): prev_pr/next_pr were computed positionally over BFS-ordered submission branches, which assigned arbitrary 'previous' relationships to independent siblings and caused merge-check.ts to block sibling merges on each other. Fixed by deriving prev_pr from the actual parent's PR and setting next_pr only for linear (single-child) continuations.

## Dependencies

- **DUB-20 (tree-walking submit):** merged 2026-05-24 in commit 86303e2 — unblocks DUB-21 by ensuring submit walks tree-shaped stacks instead of rejecting them.
- **DUB-71 (parser for tree-aware metadata):** Subsumed by DUB-21 per the issue description — the v1 metadata schema introduced here is the parser contract DUB-71 needed.

## Rollout

Pure CLI change. The first `dub submit` after this lands rewrites each PR body atomically with the new tree table + v1 metadata block; legacy metadata blocks still in the wild keep parsing because parseDubstackMetadata migrates them at read time.

- **On merge to main - Bump dubstack CLI:** Users on the new CLI version see tree-shaped tables on their next `dub submit`; metadata blocks on existing PRs continue to parse via the legacy migration path until those PRs are re-submitted.
- **Follow-up - Action webhook (DUB-71 territory):** Downstream consumers of `parseDubstackMetadata` can now rely on the v1 surface (parent/children/siblings/tree) regardless of which CLI version wrote the PR body.

## Commit

```text
feat(pr-body): tree-shaped stack table + v1 metadata schema [DUB-21]
```
