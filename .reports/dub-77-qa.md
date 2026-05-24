# Self-QA fallback — DUB-77

> Tree-aware `dub log` highlight: current sub-tree + parent path.

## Why no video

`dub log` and `dub info` are CLI commands that render ASCII trees and plain
text. There is no browser surface to record. Terminal output is the evidence.

## What was verified

Walked through a representative tree-shaped stack in `/tmp/dub77-demo`:

```
main
└─ feat/auth-base
   ├─ feat/auth-login   (current)
   └─ feat/auth-sibling
      └─ feat/auth-grandchild
```

1. **Acceptance: ancestor / current / sibling-subtree styling.**
   `FORCE_COLOR=1 dub log` emits the expected ANSI codes (verified with
   `od -c`): `feat/auth-base` wrapped in `ESC[1m … ESC[22m` (bold ancestor),
   `feat/auth-login (Current)` wrapped in bold cyan, and
   `feat/auth-sibling` + `feat/auth-grandchild` wrapped in `ESC[2m … ESC[22m`
   (dim sibling-subtree).

2. **Acceptance: `--no-color` fallback markers.**
   `dub log --no-color` (and `NO_COLOR=1 dub log`) produces no ANSI codes,
   keeps `*feat/auth-login (Current)*` and `>feat/auth-base` markers, and
   strips the tildes from sibling-subtree labels — exactly the spec.

3. **Acceptance: `logJson` includes `region`.**
   `dub log --json` returns `"region": "root" | "ancestor" | "current" |
   "sibling-subtree"` per branch; descendants get `"descendant"` (covered by
   the new logJson test in `log.test.ts`).

4. **Acceptance: `dub info` tree-position summary.**
   `dub info` on `feat/auth-login` prints:
   `On feat/auth-login (1 of 2 siblings under feat/auth-base, 0 descendants).`
   On a linear stack with no siblings or descendants, the line is omitted.

5. **Acceptance: snapshot tests.**
   `packages/cli/src/commands/log.test.ts` now covers ancestor markers,
   sibling-subtree markers, descendant absence, JSON region exposure,
   missing-ancestor labelling, and the "current not in stack" fallback.

## Evidence

- `/tmp/dub77-log-color.txt`  — `FORCE_COLOR=1 dub log` (raw bytes with ANSI codes)
- `/tmp/dub77-log-nocolor.txt` — `dub log --no-color` (plain marker fallback)
- `/tmp/dub77-info.txt`       — `dub info` summary line
- `/tmp/dub77-log-json.txt`   — `dub log --json` with `region` field per branch
- `pnpm --filter dubstack test` — 699 tests passing
- `pnpm typecheck` — green
- `pnpm checks` — biome clean

## Follow-up flag

None. Existing missing-branch handling now composes with region markers (an
earlier review caught and the fix is covered by a regression test).
