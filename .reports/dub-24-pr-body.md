## TL;DR

Adds four mutually-exclusive scope flags to `dub submit` and `dub ss`, keeps `--path current|stack` working in v1.x with a deprecation warning, refactors the submit plan around a `SubmitScope` discriminated union, and updates every caller, the MCP schema, and the docs to match.

## Why

Today's two-mode `--path current|stack` doesn't express the most common stack operations: upstack (current + descendants) and single-branch submit.

Graphite's `--upstack`/`--downstack`/`--stack`/`--branch` vocabulary is the de-facto standard users already think in.

DUB-20 made tree-shaped submits the default — flags need to follow.

### Before

- `dub submit --path current` (default) submits ancestors + current.
- `dub submit --path stack` submits the full stack from trunk.
- No way to submit only descendants of the current branch, and no way to submit a single named branch without checking it out first.

### After

- `dub submit` (default) and `--downstack` both submit current + ancestors.
- `--upstack` submits current + all descendants (new BFS walker).
- `--stack` submits the full tree from trunk.
- `--branch <name>` submits exactly one named branch from any tracked stack.
- Scope flags are mutually exclusive; `--path` still works but warns on stderr and will be removed in v2.

## File-by-file

### packages/cli/src/commands/submit.ts

mod +159 / -13

New `SubmitScope` discriminated union and `resolveScope(options)` helper. `getSubmitPlan` dispatches by scope kind. New `getUpstackBranches` walks descendants in BFS with deterministic sibling order, `getDownstackBranches` is the renamed `getCurrentPathBranches`. `--branch <name>` resolves the stack from the named branch (not the current branch).

```ts
export type SubmitScope =
  | { kind: 'downstack' }
  | { kind: 'upstack' }
  | { kind: 'stack' }
  | { kind: 'branch'; branch: string };

export function resolveScope(options: SubmitOptions): SubmitScope {
  // Throws on >1 active scope flag; emits deprecation warning for --path.
}
```

### packages/cli/src/index.ts

mod +48 / -12

Wires --upstack/--downstack/--stack/--branch on both `submit` and `ss`. Keeps --path with no default value so we can detect explicit use and warn. Help text + examples updated. `describeScopeLabel` formats the scope for terminal output.

### packages/cli/src/commands/mcp.ts

mod +33 / -7

Mirrors the CLI scope flags in the MCP `dubstack.submit` tool schema and dispatches them through `submit()`. History capture key list includes the new properties.

### packages/cli/src/commands/ready.ts

mod +6 / -6

`ReadyResult.submitPath: 'current'|'stack'|null` renamed to `submitScope: SubmitScope | null` to mirror the new shape. Calls `getSubmitPlan(..., { downstack: true })`.

### packages/cli/src/commands/merge-next.ts

mod +2 / -2

Switches to `{ downstack: true }` and replaces a `dub ss --path current` hint with the new default `dub ss`.

### packages/cli/src/commands/doctor.ts

mod +2 / -2

Remediation hints now print the simpler `dub submit` instead of `dub submit --path current`.

### packages/cli/test/commands/submit-tree.test.ts

mod +95 / -4

Adds seven tests covering each scope (default, --upstack, --downstack, --stack, --branch <name>), --branch validation against untracked names, mutex flag rejection, and both --path deprecation warnings.

```ts
it('rejects passing more than one scope flag', async () => {
  await expect(
    getSubmitPlan(dir, { upstack: true, downstack: true }),
  ).rejects.toThrow('mutually exclusive');
});
```

### apps/docs/content/docs/commands/submit.mdx

mod +34 / -7

Documents the four new flags, the mutex rule, and adds a v1->v2 migration table mapping `--path current` to `--downstack` and `--path stack` to `--stack`.

### README.md

mod +13 / -12

Top-level submit examples replaced with the new flags; deprecation notice added.

### .reports/dub-24-qa.md

new +29 / -0

Self-QA fallback for a CLI-only change. Captures the three gate runs, the four built-CLI smoke scenarios, and the adversarial-review summary.

## Where to focus review

1. **Mutual-exclusion accounting in resolveScope** - `packages/cli/src/commands/submit.ts: resolveScope`: All five flags (--upstack, --downstack, --stack, --branch, --path) participate in the same mutex tally so `--path current --upstack` is rejected with a single coherent error. Verify the flag set is what you expect.
2. **--branch <name> scope resolution** - `packages/cli/src/commands/submit.ts: getSubmitPlan (target branch lookup)`: Unlike the other scopes, `--branch <name>` does not require the current branch to be tracked — it resolves the stack from the named branch. Root branches are rejected via the existing guard with a tailored message.
3. **Upstack BFS determinism** - `packages/cli/src/commands/submit.ts: getUpstackBranches`: Sibling order is alphabetical via `localeCompare` so push order is stable across runs and matches the BFS used by `topologicalOrder`.
4. **Deprecation warning stream** - `packages/cli/src/commands/submit.ts: resolveScope (console.warn calls)`: Warnings go to stderr (Node's default for `console.warn`) so they don't contaminate stdout for scripts piping submit output, but still surface in interactive sessions.

## Test plan

- [x] **unit:** Vitest suite covering scope dispatch + mutex + deprecation warnings - 696 tests across 84 files green (`pnpm test`). Seven new tests in submit-tree.test.ts target every new path.
- [x] **manual:** Built CLI smoke: help text, mutex rejection, deprecation warning - `node packages/cli/dist/index.js submit --help` shows new flags; `submit --upstack --downstack` exits with the mutex error; `submit --path current` emits the expected warning.
- [x] **build:** Tsup bundle for the CLI - `pnpm --filter dubstack build` -> `dist/index.js` 393 KB, clean build.

## Quality gates

- **Biome (lint + format):** `pnpm checks` - passed (Checked 246 files, no fixes applied.)
- **TypeScript:** `pnpm typecheck` - passed (tsc --noEmit clean across `dubstack` and `docs` packages.)
- **Vitest:** `pnpm test` - passed (84 files, 696 tests passed; new tests in submit-tree.test.ts included.)
- **Evals:** `pnpm evals` - skipped (AI metadata generation prompts unchanged; evals require provider credentials and are out of scope per AGENTS.md.)

## Self-QA

See [QA fallback evidence](.reports/dub-24-qa.md).

Deterministic CLI evidence: gate runs + built-binary smoke tests for help text, mutex enforcement, and deprecation warning.

- `dub submit --help` shows all four new flags + deprecated --path.
- `dub submit --upstack --downstack` errors with mutex message.
- `dub submit --path current` warns on stderr then continues with downstack behaviour.
- Vitest covers all five scope kinds plus both --path warning paths.

## Acceptance criteria

- [x] Four new flags implemented with mutual exclusion - Flags declared on submit/ss in index.ts; resolveScope() rejects multi-flag combinations; unit test `rejects passing more than one scope flag` covers it.
- [x] `--path current` / `--path stack` emit deprecation warning and still work - console.warn in resolveScope() with the exact wording from the issue; two unit tests verify warning + behavioural equivalence.
- [x] `getSubmitPlan` accepts the new scope and returns correct branch sets - selectScopedBranches dispatches per kind; integration tests over a tree stack assert each branch set.
- [x] CLI help text updated - Help block under `dub submit --help` lists --upstack/--downstack/--stack/--branch with descriptions and updated Examples section.
- [x] README and migration docs updated - README.md, QUICKSTART.md, AGENTS.md, apps/docs/content/docs/commands/submit.mdx (with migration table), stack-graph.mdx, doctor.mdx, conflict-resolution.mdx, dubstack skill files all updated.
- [x] Tests for each scope and the deprecation warning - Seven new tests in `packages/cli/test/commands/submit-tree.test.ts` cover default, --upstack, --downstack, --stack, --branch, mutex, and both --path warnings.

## Adversarial review

Iterations: 1

Remaining critical/major: 0/0

Remaining minor/nitpick: 1/0

- Reviewer (feature-dev:code-reviewer) flagged one wording nit on the root-branch error path when `--branch <root>` is passed; resolved by replacing the recovery hint with 'Choose a non-root tracked branch name.' before commit.

## Dependencies

- **DUB-20 (tree-walking submit):** completed (merged into main)

## Rollout

Ship as a v1 feature: new flags are additive, existing scripts keep working with a one-time deprecation warning on stderr. v2 will remove `--path` and the `--fix` alias.

- **On merge - Ship to v1.x:** New flags become available immediately; existing `--path` users see a stderr warning per invocation but no behaviour change.
- **Before v2 - Remove --path and --fix:** Strip the deprecated `--path` option, the `SubmitPathMode` type, and the `--fix` no-op alias. Update docs to remove the migration table once v2 ships.

## Commit

```text
feat(submit): scope flags --upstack/--downstack/--branch/--stack [DUB-24]
```
