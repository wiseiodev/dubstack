## TL;DR

`dub log` now tags every branch with a region relative to the current branch (root / ancestor / current / descendant / sibling-subtree) and renders ancestor in bold, current in bright cyan, and sibling sub-trees in dim. `--no-color` keeps the markers visible as `*name (Current)*` and `>name`. `logJson` exposes the region. `dub info` adds a one-line tree-position summary on tree-shaped stacks.

## Why

Tier 1 (DUB-20) makes branching common, so users routinely sit inside trees with 3-4 sibling sub-trees under one base. Monochrome rendering forces visual scanning to figure out 'which sub-tree am I in'.

Adds a fast 'where am I' signal: bold up to trunk, bright at me, dim everywhere else.

### Before

- Only the current branch was distinguished (asterisks + bright cyan).
- Siblings and ancestors rendered identically to descendants.
- `dub info` showed parent and children but never said 'you are 1 of N siblings'.

### After

- `log()` computes a region per branch and emits inline markers (`*…*` current, `>…` ancestor, `~…~` sibling-subtree) that the CLI styling layer turns into chalk colors.
- `--no-color` strips tilde markers but keeps `*` and `>` so the same information survives in non-TTY/CI output.
- `logJson` returns a `region` field per branch (`root | ancestor | current | descendant | sibling-subtree`).
- `dub info` prints `On <branch> (N of M siblings under <parent>, K descendants).` when the stack has any branching node.

## File-by-file

### packages/cli/src/commands/log.ts

mod +110 / -0

Exports `computeRegions` and threads a `Map<branch,region>` through `renderStack` / `renderNode` / `renderStackJson`. Adds defensive visited sets to the ancestor walk and descendant BFS so a malformed parent cycle cannot hang the command. Composes the missing-branch warning with the region marker so a missing ancestor still gets the `>` highlight.

```ts
if (isRoot) {
  label = `(${branch.name})`;
} else if (branch.name === currentBranch) {
  label = `*${branch.name} (Current)*`;
} else {
  if (region === 'ancestor') label = `>${branch.name}`;
  else if (region === 'sibling-subtree') label = `~${branch.name}~`;
  else label = branch.name;
  if (!exists) label = `${label} ⚠ (missing)`;
}
```

### packages/cli/src/commands/branch.ts

mod +89 / -0

Adds `TreePosition`, `computeTreePosition`, and `countDescendants` (with cycle protection). `formatBranchInfo` appends the one-line summary when `treePosition` is non-null. Summary is emitted on tree-shaped stacks even if the current branch has no immediate siblings or descendants.

```ts
if (info.treePosition) {
  const { parent, siblingIndex, siblingCount, descendantCount } = info.treePosition;
  const descendantLabel = descendantCount === 1 ? '1 descendant' : `${descendantCount} descendants`;
  lines.push(`On ${info.currentBranch} (${siblingIndex} of ${siblingCount} siblings under ${parent}, ${descendantLabel}).`);
}
```

### packages/cli/src/index.ts

mod +22 / -0

Adds `--no-color` to `dub log` and `dub ls`. `printLog` branches on `options.color === false || chalk.level === 0`: in no-color mode it strips `~…~` markers but keeps `*…*` and `>…`; in color mode it bolds ancestors, dims sibling sub-trees, and keeps the existing current/missing styling.

```ts
const noColor = options.color === false || chalk.level === 0;
const styled = noColor
  ? output.replace(/~([^~]+?)~/g, '$1')
  : output
      .replace(/\*(.+?) \(Current\)\*/g, chalk.bold.cyan('$1 (Current)'))
      .replace(/(─ )>(\S+)/g, `$1${chalk.bold('$2')}`)
      .replace(/~([^~]+?)~/g, chalk.dim('$1'))
      .replace(/⚠ \(missing\)/g, chalk.yellow('⚠ (missing)'));
```

### packages/cli/src/commands/log.test.ts

mod +168 / -0

Updates two existing snapshots to assert the new markers, then adds a `region markers` describe block covering: ancestor labeling, sibling-subtree tildes, descendant absence of any marker, `logJson` region field per branch, missing-ancestor composition, and the 'current not in stack' fallback.

### packages/cli/src/commands/branch.test.ts

mod +74 / -0

Adds three new tests: sibling-count summary on a 3-sibling stack, omission of the summary on a linear stack with no siblings or descendants, and a stack that branches elsewhere but where the current branch is a lone leaf.

### README.md

mod +7 / -0

Documents the new region styling and the `--no-color` fallback markers under the `dub log` section.

### .reports/dub-77-qa.md

new +62 / -0

QA fallback report. CLI surface, so the evidence is raw `od -c` bytes from the rendered output plus the JSON snapshot rather than a Playwright video.

## Where to focus review

1. **Marker stripping is purely textual** - `packages/cli/src/index.ts:1515-1525`: The styling layer relies on regex matches against `*…*`, `>…`, and `~…~` inside the rendered output. Branch names can't contain `*`, `>`, `~`, or whitespace per git ref rules, so collisions aren't possible — but the assumption is worth confirming.
2. **Region precedence vs. missing branches** - `packages/cli/src/commands/log.ts:303-322`: Earlier draft made `!exists` short-circuit the region label and silently dropped the ancestor highlight for a missing ancestor. The fix composes markers — `>name ⚠ (missing)` — and a regression test in `log.test.ts` covers it.
3. **Tree-position threshold** - `packages/cli/src/commands/branch.ts:74-100`: `computeTreePosition` returns null only when (siblings ≤ 1) AND (descendants === 0) AND (stack has no branching anywhere). The middle case — lone leaf in a tree that branches elsewhere — still emits the summary; covered by a new test.

## Test plan

- [x] **unit:** region marker snapshots (ancestor / current / sibling-subtree / descendant / JSON region) - packages/cli/src/commands/log.test.ts — `region markers` describe (6 tests)
- [x] **unit:** missing ancestor still carries `>` marker - packages/cli/src/commands/log.test.ts — `keeps the ancestor marker for ancestors that are missing from git`
- [x] **unit:** tree-position summary appears / omits correctly - packages/cli/src/commands/branch.test.ts — 3 new tests covering siblings>1, linear stack, and branching-elsewhere
- [x] **manual:** FORCE_COLOR=1 dub log emits expected ANSI codes for each region - /tmp/dub77-log-color.txt + od -c inspection (ESC[1m bold for ancestor, bold cyan for current, ESC[2m dim for siblings)
- [x] **manual:** dub log --no-color and NO_COLOR=1 strip ANSI but keep markers - /tmp/dub77-log-nocolor.txt
- [x] **manual:** dub info prints sibling/descendant summary - /tmp/dub77-info.txt
- [x] **manual:** dub log --json includes region per branch - /tmp/dub77-log-json.txt

## Quality gates

- **lint + format:** `pnpm checks` - passed (biome check . — Checked 246 files, no fixes applied)
- **typecheck:** `pnpm typecheck` - passed (turbo run typecheck — 2 successful, 2 total)
- **tests:** `pnpm test` - passed (84 test files, 699 tests passed)
- **evals:** `pnpm evals` - skipped (AGENTS.md only requires evals when AI metadata/prompts change; this PR touches neither. Local environment also lacks AI provider credentials so evals would fail unrelated to this work.)

## Self-QA

See [QA fallback evidence](.reports/dub-77-qa.md).

Self-QA fallback with terminal output evidence (raw bytes + JSON snapshot).

- FORCE_COLOR=1 dub log on a 5-branch tree-shaped stack
- dub log --no-color on the same stack
- NO_COLOR=1 dub log on the same stack
- dub info on the current (login) branch
- dub log --json on the same stack

## Acceptance criteria

- [x] `dub log` renders ancestor path, current branch, and sibling sub-tree with distinguishable styling - Verified via FORCE_COLOR=1 od -c inspection (ESC[1m ancestor, bold cyan current, ESC[2m sibling-subtree) and the new `region markers` unit tests.
- [x] `dub log --no-color` falls back to a non-color marker (e.g. `*` for current, `>` for ancestor) - New `--no-color` CLI flag plus `chalk.level === 0` detection; verified manually (`/tmp/dub77-log-nocolor.txt`).
- [x] `logJson` includes the `region` field per branch - `LogJsonBranch.region: LogRegion` exported; verified in `logJson` unit test and `/tmp/dub77-log-json.txt`.
- [x] `dub info` prints the sibling-count summary on tree-shaped stacks - `formatBranchInfo` appends `On <branch> (N of M siblings under <parent>, K descendants).` when `treePosition` is set; three new unit tests cover the trigger conditions.
- [x] Snapshot tests for ancestor-only, current, and sibling-subtree regions - `packages/cli/src/commands/log.test.ts` adds explicit assertions for ancestor `>` marker, current `*…*` marker, sibling-subtree `~…~` marker, and absence of any marker on descendants, plus a logJson region snapshot.

## Adversarial review

Iterations: 1

Remaining critical/major: 0/0

Remaining minor/nitpick: 0/0

- Critical: missing-ancestor label silently dropped the `>` marker — fixed by composing the missing suffix with the region marker; regression test added.
- Major: marker-stripping regex `[^\s~]+` would mis-handle branch names with whitespace — tightened to `[^~]+?` for both color and no-color branches.
- Major: missing test coverage for `stackHasBranching=true, siblings=1, descendants=0` — added `reports tree position even when current has no siblings if stack branches elsewhere`.

## Dependencies

- **DUB-20 (tree-walking submit):** satisfied — merged (commit 86303e2). The branching-blocker rejection is removed, so trees with sibling sub-trees are now first-class stack shapes that need the new visual treatment.

## Rollout

Ship behind no flag. Visual change to `dub log` and additive line to `dub info`; both are local, read-only commands.

- **Merge - Land PR on main:** Squash-merge keeps history linear per AGENTS.md.
- **Post-merge - No further action:** No DB migration, no remote state, no flag. Tier 1 docs already announce the branching-stack focus.

## Commit

```text
feat(log): region-aware tree highlight + `dub info` tree position

`dub log` now tags each branch as `root | ancestor | current | descendant |
sibling-subtree` relative to the current branch and styles them accordingly
(bold ancestor, bright cyan current, dim sibling sub-tree). `--no-color`
falls back to text markers (`*` current, `>` ancestor). `logJson` exposes
`region` per branch. `dub info` adds a one-line tree-position summary on
tree-shaped stacks.

Completes DUB-77
```
