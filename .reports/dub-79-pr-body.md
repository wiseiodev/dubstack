## TL;DR

Adds a `createSubTreeTagger(stack, trunk)` helper to `submit.ts` that derives the deepest ancestor-with-siblings for each branch, and feeds the result (`subtreeRoot · branch` or just `branch`) into the existing `progress.update(..., detail)` calls in both the push and PR-sync loops. Linear stacks and direct trunk children render unchanged.

## Why

Tree submit (DUB-20) and scope flags (DUB-24) made tree-shaped stacks first-class, but the progress bar still labels each line with only the branch name — adjacent updates can hop between unrelated sub-trees in sibling-alphabetical BFS order, which is hard to follow.

Annotating the label with the local fork point gives a stable visual anchor for which sub-tree each update belongs to.

### Before

- 🚀 Pushing branches [████████░░░░░] 12/30  feat/auth-login
- Next update may jump to `feat/dashboard-view` with no sub-tree context — the user has to mentally re-locate the branch in the tree on every line.

### After

- 🚀 Pushing branches [████████░░░░░] 12/30  feat/auth-base · feat/auth-login
- Next line: `feat/dashboard · feat/dashboard-view` — the sub-tree root makes the jump explicit. Branches directly on trunk and purely linear stacks render unchanged (no breaking `·`).

## File-by-file

### packages/cli/src/commands/submit.ts

mod +80 / -2

Adds an exported `createSubTreeTagger(branches, trunkName)` helper (plus its private `deriveSubTreeTag` walker) and threads the tagger into both `progress.update` call sites (push loop + PR-sync loop). The walk starts at the branch's parent, scans toward trunk, and returns the first ancestor that itself has at least one sibling. Returns null for direct trunk children and linear stacks; a `seen` set guards against malformed cyclic state. The `·` separator lives in a named `SUB_TREE_SEPARATOR` constant.

```typescript
const subTreeTagger = createSubTreeTagger(
  plan.stack.branches,
  plan.rootBranch,
);
// ...
progress.update('🚀 Pushing branches', pushIndex, subTreeTagger(branch.name));
// ...
progress.update('📬 Syncing PRs', prIndex, subTreeTagger(branch.name));

const SUB_TREE_SEPARATOR = ' · '; // U+00B7

export function createSubTreeTagger(
  branches: Branch[],
  trunkName: string,
): (branchName: string) => string {
  const branchByName = new Map(branches.map((b) => [b.name, b]));
  const childCountByParent = new Map<string, number>();
  for (const branch of branches) {
    if (branch.parent != null) {
      childCountByParent.set(
        branch.parent,
        (childCountByParent.get(branch.parent) ?? 0) + 1,
      );
    }
  }
  return (branchName) => {
    const tag = deriveSubTreeTag(branchName, branchByName, childCountByParent, trunkName);
    return tag ? `${tag}${SUB_TREE_SEPARATOR}${branchName}` : branchName;
  };
}
```

### packages/cli/src/commands/submit-progress.test.ts

new +136 / -0

Eight unit tests cover the label format across the spec's required scenarios plus regression cases surfaced by an adversarial review: linear stack (no `·` anywhere), branches sitting directly on trunk (no prefix), a single-fork tree (matches the issue's worked example `feat/auth-base · feat/auth-login`), a two-deep nested fork (verifies we pick the *deepest* ancestor with siblings, not the shallowest), the `A → {B, C}` case where no ancestor has siblings, an unknown-branch fallback, the root branch name itself, and the `'(unknown)'` trunk fallback that `getSubmitPlan` emits for malformed state.

```typescript
it('prefixes descendants with the deepest ancestor that has siblings', () => {
  const branches = makeBranches([
    { name: 'main', parent: null, root: true },
    { name: 'feat/auth-base', parent: 'main' },
    { name: 'feat/auth-login', parent: 'feat/auth-base' },
    { name: 'feat/auth-logout', parent: 'feat/auth-base' },
    { name: 'feat/dashboard', parent: 'main' },
  ]);
  const tag = createSubTreeTagger(branches, 'main');
  expect(tag('feat/auth-login')).toBe('feat/auth-base · feat/auth-login');
  expect(tag('feat/auth-logout')).toBe('feat/auth-base · feat/auth-logout');
  expect(tag('feat/auth-base')).toBe('feat/auth-base');
  expect(tag('feat/dashboard')).toBe('feat/dashboard');
});
```

## Where to focus review

1. **deriveSubTreeTag walks the right direction & stops at the deepest fork** - `packages/cli/src/commands/submit.ts:539-560`: The spec's 'deepest shared ancestor with siblings' means the closest fork above the branch. The walk starts at branch.parent and returns on the FIRST ancestor whose parent has >1 children, which is correct (closest to the branch = deepest in tree). Confirm the early `branch.parent === trunkName` guard correctly skips direct trunk children, and that the `seen` set guard keeps malformed cyclic state from spinning forever.
2. **Tagger uses full stack topology, not the scoped submit set** - `packages/cli/src/commands/submit.ts:159`: `createSubTreeTagger(plan.stack, plan.rootBranch)` builds `childCountByParent` from the full stack so a `--branch X` run still labels X correctly relative to its actual sibling shape. Intentional — confirm reviewer agrees this matches 'sub-tree context' semantics rather than 'sub-tree of the submit set'.
3. **Progress format string still fits the new detail** - `packages/cli/src/lib/progress.ts:86-87`: The cli-progress format is `'{label} [{bar}] {value}/{total} {detail}'`. The new detail is just a longer string (`subtreeRoot · branch`); no format change needed. Confirm rendering looks right on a narrow terminal — cli-progress truncates/clears via cursor escapes, so longer detail strings simply consume more horizontal space.

## Test plan

- [x] **unit:** createSubTreeTagger covers linear / trunk-child / single-fork / deep-fork / branch-as-fork / unknown-branch - packages/cli/test/commands/submit-progress.test.ts — 6 cases, all passing.
- [x] **build:** Full vitest suite - pnpm test → 86 test files, 767 tests, all passing.

## Quality gates

- **lint + format:** `pnpm checks` - passed (biome check . — Checked 257 files in 36ms. No fixes applied.)
- **typecheck:** `pnpm typecheck` - passed (turbo typecheck — 2 tasks successful (docs cached, dubstack fresh).)
- **unit tests:** `pnpm test` - passed (767 tests passing across 86 files.)

## Self-QA

See [QA fallback evidence](.reports/dub-79-qa.md).

Fallback QA documenting the verified label formats for linear, trunk-child, and tree-shaped stacks, with acceptance-criteria → test mapping.

- Linear stack: progress detail equals just the branch name.
- Direct trunk child (with or without siblings): progress detail equals just the branch name.
- Tree with sub-tree (worked example from issue): progress detail equals `feat/auth-base · feat/auth-login`.
- Deep nested fork: tagger returns the deepest ancestor-with-siblings (e.g. `leftBranch · leftLeaf`), not the shallowest.

## Acceptance criteria

- [x] Progress update lines show sub-tree context on tree-shaped stacks - Tests `prefixes descendants with the deepest ancestor that has siblings` and `uses the deepest forked ancestor, not the trunk-child` in submit-progress.test.ts; integration sites at submit.ts push loop & PR-sync loop.
- [x] Linear stacks render unchanged (no breaking `·`) - Test `returns the branch name unchanged in a linear stack` and `does not prefix branches that sit directly on trunk` both assert the detail is the bare branch name.
- [x] Snapshot tests for the update label format in linear and tree scenarios - submit-progress.test.ts contains 6 equality assertions across the linear, trunk-child, single-fork, deep-fork, and edge cases.

## Adversarial review

Iterations: 2

Remaining critical/major: 0/0

Remaining minor/nitpick: 0/2

- Pass 1 (clean) flagged only one nit: tagger re-walks ancestors O(N×D) without memoization — inconsequential at stack scale.
- Pass 2 (more aggressive) surfaced fixable items addressed in commit a46c3c7: removed unnecessary `export` on `deriveSubTreeTag`, switched `createSubTreeTagger` parameter from `Stack` to `Branch[]` per the small-pure-helpers styleguide, corrected JSDoc that conflated "deepest ancestor with siblings" with "closest fork point," hoisted the `·` magic separator to a named constant, moved the unit-test file from `test/commands/` to `src/commands/` (since it has no integration fixtures), and added regression tests for the root branch name and the `(unknown)` trunk fallback.
- Skipped: relocating helpers into `lib/` (low-value; they are submit-specific) and renaming `siblingCount` (current name is clear in context).

## Dependencies

- **DUB-20 — tree-walking submit:** Merged on main (commit 22e60bb and predecessors enabled tree-shaped submit ordering).
- **DUB-24 — submit scope flags:** Merged on main (52ae5ac) — `--upstack`/`--downstack`/`--stack`/`--branch` all flow through `getSubmitPlan` and feed the tagger.

## Rollout

Pure additive change to the CLI's progress label text. No state shape, no flag, no breaking change. Lands on next dubstack release.

- **On merge to main - Ship in next CLI release:** No migration. Users on tree-shaped stacks see the new `subtreeRoot · branch` format on next `dub submit`. Users on linear stacks see no change.

## Commit

```text
feat(submit): annotate progress bar with sub-tree context + review fixups
```
