# Self-QA fallback - DUB-26

> This work item has no useful browser recording surface, so this file replaces
> the video and records deterministic proof instead.

## Why no video

`dub log` is a terminal CLI command — there is no browser surface to record.
No `.tsx` files were touched in this change.

## What was verified

1. **Unit tests** — 836/836 pass via `pnpm test`, including 9 new tests in
   `packages/cli/src/commands/log.test.ts` that exercise:
   - rich PR + CI + commit annotation rendering on a linear stack
   - `--no-prs` hides PR annotations, keeps CI + commit
   - `--no-ci` hides CI, keeps PR + commit
   - draft / merged / closed / changes-requested glyph hierarchy
   - graceful fallback to plain region-only tree when `overview` is null
   - additive JSON shape: new fields present only when overview is provided
   - JSON exposes `prState`, `prTitle`, `reviewDecision`, `ciState`, `draft`,
     `committedRel`, `shortSha` and the reserved `frozen` placeholder
   - ANSI styling applied to suffix tokens only when `noColor` is false
   - rich rendering on a branching tree with sibling-subtree styling
2. **Type-check** — `pnpm typecheck` passes.
3. **Lint** — `pnpm checks` (biome) passes with 271 files clean.
4. **Manual end-to-end** in a throwaway repo with a hand-crafted
   `.git/dubstack/overview-cache.json` fixture; recorded outputs below.

## Evidence

### Rich view (no-color)

```
(main)  3 minutes ago · 1111aaaa
  └─ >feat/a  #42 ✔ approved · ✔ ci · 2 minutes ago · aaaa2222
       └─ *feat/b (Current)*  #43 ✏ draft · ⏳ ci · 1 minute ago · bbbb3333
```

### Rich view (FORCE_COLOR=1)

ANSI codes wrap suffix tokens (`✔ approved` → green; `⏳ ci` → yellow;
`✏ draft` → dim; commit meta → dim) without double-coloring the region-
styled branch name. Draft glyph beats `REVIEW_REQUIRED` per the
glyph hierarchy in `formatPrToken`.

### `--no-prs`

```
(main)  3 minutes ago · 1111aaaa
  └─ >feat/a  ✔ ci · 2 minutes ago · aaaa2222
       └─ *feat/b (Current)*  ⏳ ci · 1 minute ago · bbbb3333
```

### `--no-ci`

```
(main)  3 minutes ago · 1111aaaa
  └─ >feat/a  #42 ✔ approved · 2 minutes ago · aaaa2222
       └─ *feat/b (Current)*  #43 ✏ draft · 1 minute ago · bbbb3333
```

### `--refresh` with unauthed `gh`

Cache bust forces a fresh fetch; the batched `gh pr list` fails;
`printLog`'s try/catch swallows the error and renders the plain
region-only tree:

```
(main)
  └─ >feat/a
       └─ *feat/b (Current)*
```

### `--json` (overview-present shape)

`logJson` includes the new optional fields keyed off per-branch overview
rows. Sample fragment for `feat/b`:

```json
{
  "name": "feat/b",
  "current": true,
  "region": "current",
  "prState": "OPEN",
  "prTitle": "feat: b",
  "reviewDecision": "REVIEW_REQUIRED",
  "ciState": "PENDING",
  "draft": true,
  "committedRel": "1 minute ago",
  "shortSha": "bbbb3333"
}
```

When `overview` is absent the new fields are strictly omitted (asserted by
`omits rich JSON fields when overview is absent so consumers see additive-only shape`).

## Follow-up flag

`frozen` is wired through the type but stays `undefined` until DUB-37
introduces `dub freeze`. No work needed here — the BranchOverview pipeline
will populate it once the freeze flag lands.

The `--commits N` flag from the implementation notes is intentionally
deferred: it is not in the DUB-26 acceptance criteria, requires a separate
batched git call, and would expand scope without a concrete UX spec.
