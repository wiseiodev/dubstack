## TL;DR

`dub log` now appends per-branch PR-state glyph, CI rollup, last-commit relative time, and short SHA after each label, sourced from `getStackOverviewBatch`. When `gh` is unauthed the rich data is silently dropped and the existing region-only tree renders unchanged. JSON output extends `LogJsonBranch` with optional `prState`, `prTitle`, `reviewDecision`, `ciState`, `draft`, `committedRel`, `shortSha`, and a reserved `frozen` placeholder for DUB-37.

## Why

DUB-77 added region-aware tree highlighting in `dub log` but the row text still showed only branch names — users had to flip to the GitHub UI to learn PR state, CI status, or how stale each branch was.

DUB-25 already batches the underlying data into a 30 s cached overview. This issue lights up the first consumer (`dub log` + `dub mcp dubstack.log`) so the work isn't dead inventory.

Failing soft for users without GitHub authentication is a hard requirement — the plain region-only tree must keep working unchanged when `gh` is missing, unauthed, or offline.

### Before

- `dub log` rendered `(main)\n  └─ >feat/a\n       └─ *feat/b (Current)*` — branch names and regions only.
- `logJson` returned `name, type, parent, current, exists, prNumber, prLink, region, children`. No PR title, CI rollup, or commit metadata.
- MCP `dubstack.log` mirrored the bare JSON shape; LLM consumers had to N+1 over `gh pr view` to enrich it.

### After

- `dub log` (text mode) appends `  #42 ✔ approved · ✔ ci · 2 minutes ago · aaaa2222` to each branch label, color-coded per state and dimmed otherwise.
- `logJson` extends `LogJsonBranch` with `prState`, `prTitle`, `reviewDecision`, `ciState`, `draft`, `committedRel`, `shortSha`, and reserved `frozen`. Fields are strictly omitted when no overview was provided — old consumers see the exact prior shape.
- MCP `dubstack.log` schema gains `prs`, `ci`, `refresh` booleans and fail-softly returns the bare tree when the overview fetch errors.
- New CLI flags: `--no-prs`, `--no-ci`, `--refresh`. `--no-color` strips ANSI from suffix tokens via a scoped Chalk instance so the existing `styleLogOutput` marker pipeline stays untouched.
- Truncation banner (`ℹ Showing N+ branches`) surfaces when `gh pr list` hits the page limit.

## File-by-file

### packages/cli/src/commands/log.ts

mod +241 / -14

Adds `LogOptions.{prs, ci, noColor, overview}`, extends `LogJsonBranch` with optional rich fields, threads `overviewMap` and a scoped `suffixChalk` through both recursive renderers, and implements `formatRichSuffix` / `formatPrToken` / `formatCiToken`. Glyph hierarchy: MERGED → CLOSED → DRAFT → APPROVED → CHANGES_REQUESTED → REVIEW_REQUIRED → open (bare). CI suppresses the `NONE` glyph silently.

```typescript
function makeSuffixChalk(noColor: boolean): ChalkInstance {
  // A scoped chalk instance keeps the suffix styling decision local to
  // `log()` so callers don't have to mutate the global chalk.level (which
  // would race with concurrent renders and leak across vitest cases).
  if (noColor) return new Chalk({ level: 0 });
  return chalk;
}
```

### packages/cli/src/index.ts

mod +49 / -5

Adds `--no-prs`, `--no-ci`, `--refresh` flags on both `dub log` and `dub ls`, wraps `getStackOverviewBatch` in try/catch in `printLog`, and emits the truncation banner (guarded against the `branches.length === 0` cosmetic edge case from the adversarial review).

```typescript
let overview = null;
try {
  overview = await getStackOverviewBatch(cwd, { refresh: options.refresh });
} catch {
  overview = null;
}
```

### packages/cli/src/commands/mcp.ts

mod +35 / -6

Extends the `dubstack.log` tool schema with `prs`, `ci`, `refresh` booleans, lists them in `HISTORY_ARG_KEYS`, and threads the same fail-soft overview fetch into the handler so MCP clients see the rich JSON when `gh` is authed and the plain tree otherwise.

```typescript
case 'dubstack.log': {
  const refresh = optionalBoolean(args.refresh);
  let overview = null;
  try {
    overview = await getStackOverviewBatch(cwd, { refresh });
  } catch {
    overview = null;
  }
  return jsonToolResult(
    await logJson(cwd, {
      stack: optionalBoolean(args.stack),
      all: optionalBoolean(args.all),
      reverse: optionalBoolean(args.reverse),
      prs: optionalBoolean(args.prs),
      ci: optionalBoolean(args.ci),
      overview,
    }),
  );
}
```

### packages/cli/src/commands/log.test.ts

mod +417 / -1

Adds a `rich overview` suite covering: linear-stack annotation, `--no-prs`, `--no-ci`, the full glyph hierarchy (draft / merged / closed / changes-requested), fallback when `overview: null`, additive JSON contract (fields strictly omitted when overview absent), ANSI styling under `noColor: false`, and a branching tree with sibling-subtree styling combined with rich annotations.

```typescript
it('emits the rich JSON fields when overview is provided', async () => {
  // ...
  const json = await logJson(dir, { overview });
  const featA = json.stacks[0]?.root?.children[0];
  expect(featA?.prState).toBe('OPEN');
  expect(featA?.reviewDecision).toBe('APPROVED');
  expect(featA?.ciState).toBe('SUCCESS');
  expect(featA?.draft).toBe(false);
  expect(featA?.committedRel).toBe('1 hour ago');
  expect(featA?.shortSha).toBe('aaaa1111');
  expect(featA?.frozen).toBeUndefined();
  // ...
});
```

### .reports/dub-26-qa.md

new +106 / -0

Self-QA fallback. No `.tsx` files changed; there is no browser surface to record. Captures unit-test count, manual CLI demo outputs across all four flag combinations, the gh-unauthed fallback, and the JSON shape evidence.

## Where to focus review

1. **Fail-soft path for gh failures** - `packages/cli/src/index.ts (printLog) + packages/cli/src/commands/mcp.ts (dubstack.log handler)`: The contract is that `dub log` MUST keep working when `gh` is unauthed, missing, or offline. Both call sites wrap `getStackOverviewBatch` in try/catch and pass `overview: null` on failure; downstream code treats `null` as 'render plain region-only tree' via `buildOverviewMap` returning an empty Map.
2. **JSON additive contract** - `packages/cli/src/commands/log.ts (renderNodeJson) + log.test.ts (`omits rich JSON fields when overview is absent`)`: Adding rich fields to `LogJsonBranch` cannot break existing MCP consumers reading `prNumber`, `region`, etc. New fields are populated only when the per-branch overview row exists; the 'omits' test pins this so future contributors can't accidentally make them required.
3. **Glyph hierarchy in formatPrToken** - `packages/cli/src/commands/log.ts (formatPrToken)`: MERGED beats everything; CLOSED beats DRAFT; DRAFT beats reviewDecision (so a stale APPROVED on a now-draft PR doesn't mislead). The 'renders the correct PR-state glyph' test covers all four hierarchies.
4. **Scoped Chalk avoids polluting styleLogOutput** - `packages/cli/src/commands/log.ts (makeSuffixChalk + formatPrToken/formatCiToken)`: The suffix is styled inline before `styleLogOutput` runs over the assembled output. The three existing label-marker regexes (`*name (Current)*`, `(─ )>name`, `~name~`) cannot collide with the suffix because branch names cannot contain spaces (per git refname rules) and the suffix begins with two spaces — `\S+` in the ancestor regex stops at the gap. Adversarial review confirmed no collision path with current inputs.

## Test plan

- [x] **unit:** 9 new tests in src/commands/log.test.ts covering rich rendering, flags, glyph hierarchy, fallback, and JSON shape - pnpm test → 836 passed (89 files)
- [x] **manual:** End-to-end demo against a throwaway repo with a hand-crafted overview cache fixture - `.reports/dub-26-qa.md` records the four flag-combination outputs plus the gh-unauthed fallback
- [x] **build:** tsup build of `packages/cli` succeeds and the built binary runs - `pnpm --filter dubstack build` → `ESM ⚡️ Build success in 180ms`; built binary invoked manually for the demo

## Quality gates

- **Biome lint + format:** `pnpm checks` - passed (Checked 271 files in 53ms. No fixes applied.)
- **TypeScript:** `pnpm typecheck` - passed (turbo: 2 successful, 2 total (cached for docs, cache miss + clean for dubstack))
- **Vitest:** `pnpm test` - passed (89 files, 836 tests passed (was 827 before; +9 new))
- **AI evals:** `pnpm evals` - skipped (No AI metadata or prompts changed in this PR; the local eval harness requires an AI provider key which is not configured in this environment. Per CLAUDE.md, evals are only required when AI metadata changes.)

## Self-QA

See [QA fallback evidence](.reports/dub-26-qa.md).

Deterministic proof of the four flag-combination outputs and the gh-unauthed fallback path.

- Rich view (no-color) shows PR + CI + commit annotations on every row
- Rich view (FORCE_COLOR=1) wraps each suffix token in the expected ANSI codes
- --no-prs hides PR data, keeps CI + commit
- --no-ci hides CI rollup, keeps PR + commit
- --refresh busts the cache; with unauthed gh, falls back to the plain region-only tree
- --json emits the rich optional fields when an overview is present

## Acceptance criteria

- [x] `dub log` defaults to the rich view when `gh` is authed; falls back to region-only tree otherwise - printLog (index.ts) fetches overview unconditionally, fails soft to `null`; log() renders rich suffix only when overview is present. Manual demo confirms both paths.
- [x] `--no-prs`, `--no-ci`, `--no-color`, `--refresh` flags work - All four flags wired in index.ts on both `dub log` and `dub ls`; tests + manual demo cover each.
- [x] `--json` extends `LogJsonResult` additively (consumers reading old fields keep working) - All new fields are optional; the 'omits rich JSON fields' test asserts they are strictly absent when overview is not provided.
- [x] `logJson` consumed by `dub mcp`'s `dubstack.log` reflects the new optional fields - MCP handler fetches the same overview and passes it into `logJson`. The tool schema also documents the three new flags.
- [x] Snapshot tests for several stack shapes (linear, tree, gh-unauthed fallback, --no-color) - 9 new assertion-style tests in `log.test.ts` cover linear, branching, fallback (overview: null), --no-prs, --no-ci, --no-color via noColor flag, plus the glyph hierarchy.
- [x] No regression in existing `log.test.ts` (DUB-77 tests must still pass) - All 27 prior log.test.ts tests still pass; 836 total tests pass.

## Adversarial review

Iterations: 1

Remaining critical/major: 0/0

Remaining minor/nitpick: 1/0

- Advisory (addressed): the truncation banner could read 'Showing 0+ branches' in a theoretical edge case where the gh page-limit heuristic trips with an empty branches array. Fixed by guarding the banner with `overview.branches.length > 0`.
- Reviewer confirmed no marker/regex collision is possible: the three styleLogOutput regexes cannot match suffix content because git refnames forbid spaces, and the suffix begins with two spaces.
- Reviewer confirmed glyph hierarchy in formatPrToken (MERGED > CLOSED > DRAFT > APPROVED > CHANGES_REQUESTED > REVIEW_REQUIRED > bare) is correct and consistent with the JSON path.

## Dependencies

- **DUB-25 (batched PR/CI data layer):** Done — `getStackOverviewBatch` consumed directly
- **DUB-77 (region-aware log highlight):** Done — `computeRegions` and `styleLogOutput` reused unchanged
- **DUB-37 (`dub freeze`):** Not yet started — `frozen?: boolean` reserved in the JSON shape; renderer will pick it up automatically once `BranchOverview.frozen` is populated.

## Rollout

Pure CLI/MCP additive change; no schema migration or persisted state changes. Merge unblocks Tier 2 follow-ups (`dub co`, `dub status`, `dub watch`).

- **On merge - Ship via the standard semantic-release flow:** No additional rollout steps. Users without `gh` see no behavior change; users with `gh` authed see the rich suffix on next `dub log` invocation.
- **Follow-up - Wire `getStackOverviewBatch` into `dub co`, `dub status`, `dub watch`:** Same overview, same cache — those consumers can fetch once per process tick and share the cached result. Each is its own ticket in Tier 2.
- **After DUB-37 - Populate `frozen` from `BranchOverview.frozen` once `dub freeze` lands:** No renderer changes needed — `frozen` is already in the JSON contract and the rich suffix can be extended to surface it without touching the data layer.

## Commit

```text
feat(log): rich PR/CI/commit annotations on `dub log` tree [DUB-26]
```
