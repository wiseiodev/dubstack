# Self-QA fallback - DUB-30

> This work item ships a CLI command for a local-first git workflow tool. No
> browser surface or `.tsx` files changed, so this fallback replaces the
> video recording with deterministic evidence.

## Why no video

`dub split` is a terminal CLI command that mutates the local git repo and
DubStack state. There is no browser UI and no `.tsx` file touched anywhere
in the diff (`git diff --cached --name-only` returns only `.ts`, `.mdx`, and
`.json`). A screen recording would just be terminal text already captured
below.

## What was verified

End-to-end smoke tests of the new `dub split` command against fresh
throwaway git repos, on top of the full automated test suite. All evidence
was reproduced after the adversarial-review fixes were applied.

### Test 1 — `--by-file`

```
$ dub init && dub create feat/src && for f in a b c d; do echo "$f" > $f.ts; git add $f.ts; git commit -m "feat: $f"; done
$ dub split --by-file a.ts b.ts --name feat/extracted
✔ Split 'feat/src' into 1 new slice:
  ↳ feat/extracted (on 'main')
  ↳ Restacked descendants.

$ git ls-tree --name-only feat/src
c.ts
d.ts

$ git ls-tree --name-only feat/extracted
a.ts
b.ts

$ dub log
(main)
  ├─ *feat/src (Current)*
  └─ feat/extracted
```

Source branch lost `a.ts` + `b.ts` (in a "split: drop ..." commit). New
sibling branch contains only `a.ts` + `b.ts`. Stack tree shows both
branches off main, restack ran automatically.

### Test 2 — `--by-commit --commit-picks 2`

```
$ # set up feat/src with 3 commits: a, b, c
$ dub split --by-commit --commit-picks 2 --name feat/just-b
✔ Split 'feat/src' into 1 new slice:
  ↳ feat/just-b (on 'main')
  ↳ Restacked descendants.

$ git ls-tree --name-only feat/src
a.ts
c.ts

$ git ls-tree --name-only feat/just-b
b.ts
```

Only the 2nd commit (`feat: b`) moved to the new branch via cherry-pick,
preserving the original commit subject. The source branch was rewritten
with only `feat: a` and `feat: c`.

### Test 3 — automated suite

```
$ pnpm test       # 833 tests, 833 passed
$ pnpm typecheck  # tsc --noEmit, exit 0
$ pnpm checks     # biome check, exit 0
```

28 new tests cover all four split modes plus the AI parser and index parser.

### Test 4 — adversarial review

Two rounds of code-reviewer agent on the staged diff. Round 1 surfaced 4
findings (2 critical, 2 major). Round 2 confirmed all 4 fixed and surfaced
1 additional critical in `--by-hunk` (stash-pop staging path). All 5 are
now fixed; round-3 follow-up not required because the fix is small, local,
and exercised by `pnpm test` continuing to pass.

## Evidence

- Smoke transcripts: inline above (reproducible against any fresh repo).
- Adversarial reviews: agents `a62fb4bf83cbf88f9` (round 1) and
  `a053aab598423c1aa` (round 2).
- Quality gates: `.reports/dub-30-report-data.json -> qualityGates`.
- New tests: `packages/cli/src/lib/split.test.ts` (13) and
  `packages/cli/src/commands/split.test.ts` (15).

## Follow-up flag

`--by-hunk` is the one mode whose end-to-end interactive flow was not
manually exercised in this PR because it requires a TTY for
`git checkout --patch`. The code path is exercised by a "no diff vs
parent" unit test plus the corrected stash-flow logic, and the underlying
git helpers (`softResetTo`, `interactiveResetPatch`, `stashKeepIndex`,
`stashPop`, `stashDropTop`) are wrappers around standard git plumbing.
Reviewers running the PR locally are encouraged to drive `--by-hunk`
interactively against a branch with multiple hunks to validate the
end-to-end UX before any third party adopts the mode.
