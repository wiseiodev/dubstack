# QA Fallback — DUB-35 `dub rename`

**Reason video QA is N/A:** No `.tsx` files changed. This is a CLI-only feature
with no browser surface. Fallback QA evidence below covers the new command's
behavior end-to-end via the integration test suite, which exercises the same
code paths a user would hit at the shell.

## Scenarios verified

1. **Rename current branch** — `rename(dir, 'feat/new')` updates state, git
   branch, and current HEAD. (`renames the current tracked branch and updates
   state + git`)
2. **Rename specific branch by old/new args** — `rename(dir, 'feat/a',
   'feat/a-renamed')` works when invoked from any other branch and re-parents
   children. (`renames a specific branch by old/new args`)
3. **Re-parenting children** — children of the renamed branch get their
   `parent` updated. (`re-parents children when the renamed branch has children`)
4. **Tracked-branch collision** — DubError with recovery hint when new name is
   already tracked. (`throws when the new name collides with a tracked branch`)
5. **Untracked-local collision** — DubError when new name exists as plain git
   branch. (`throws when the new name collides with an untracked local branch`)
6. **Invalid name** — DubError on illegal git ref. (`throws on invalid new
   branch name`)
7. **Untracked source** — DubError when renaming a non-DubStack branch.
   (`throws when the source branch is not tracked`)
8. **Root branch refusal** — DubError when targeting the root. (`throws when
   targeting the root branch`)
9. **Self-rename** — DubError when old === new. (`throws when old and new are
   identical`)
10. **Undo entry shape** — operation: 'rename', renameFrom/renameTo set.
    (`saves a rename undo entry`)
11. **Undo round-trip** — name, state, child parents all restored. (`undo
    restores the old branch name and parent links`)
12. **last-pushed ref migration** — `refs/dubstack/last-pushed/<old>` is moved
    to `<new>` so the next push keeps `--force-with-lease` race protection.
    (`migrates the local last-pushed tracking ref to the new branch name`)
13. **Undo reverses last-pushed migration** — ref restored to original name.
    (`undo restores the last-pushed tracking ref to the old branch name`)
14. **PR-aware push** — `pushBranch` invoked iff a PR is linked. (`pushes the
    renamed branch when a PR is linked`, `skips push when no PR is linked`)
15. **`--no-push` flag** — skips push even when PR exists. (`skips push when
    --no-push is provided even if PR exists`)

All 16 rename tests + 5 undo tests pass. Full suite: 819/819 passing
(`pnpm test`). Biome + typecheck clean.

## Evidence

```
$ pnpm vitest run src/commands/rename.test.ts src/commands/undo.test.ts
 ✓ src/commands/undo.test.ts (5 tests)
 ✓ src/commands/rename.test.ts (16 tests)
 Test Files  2 passed (2)
      Tests  21 passed (21)
```

```
$ pnpm test
 Test Files  89 passed (89)
      Tests  819 passed (819)
```
