# DUB-42 Self-QA — `dub stash`

## Why fallback QA

This is a non-browser CLI feature. There are no `.tsx` files in the diff (changes are pure TypeScript CLI command + library + JSON state file + MDX docs). A Playwright video would not exercise anything the unit tests + transcript below don't already cover, so fallback QA is appropriate per do-issue's "non-browser-demoable" path.

## Environment

- Branch: `feature/dub-42-dub-stash-dub-stash-pop-branch-aware-stashing`
- Date: 2026-05-24
- Built CLI binary: `packages/cli/dist/index.js` (built via `pnpm build`)
- Tested commands: `dub stash`, `dub stash pop [--on <branch>] [--force]`, `dub stash list`, `dub mcp` tools/list

## Automated tests

- `pnpm test` → **933 passed / 99 files passed**, including:
  - `src/commands/stash.test.ts` — 14 tests covering all push/pop/list paths plus the four acceptance-criterion paths.
  - `src/lib/stash-log.test.ts` — 5 tests covering ring-buffer behavior, corrupt-file tolerance, removal by SHA.
  - `src/commands/mcp.test.ts` — updated to include the three new tool names (`dubstack.stash`, `dubstack.stash-pop`, `dubstack.stash-list`).
- `pnpm typecheck` → green.
- `pnpm checks` (biome) → green.

## Manual end-to-end transcript (built CLI in a temp repo)

```
=== Self-QA transcript for DUB-42: dub stash ===
tmpdir: /tmp/dub-stash-qa.AZryIu
Sun May 24 14:13:06 PDT 2026

--- setup ---
 create mode 100644 baseline.txt
✔ DubStack initialized
 create mode 100644 .gitignore

--- 1) stash with clean tree should error ---
✖ Nothing to stash — working tree is clean.

What you can do:
  1. Make changes (or stage them with 'git add'), then rerun 'dub stash'.
  2. Run 'git status' to confirm the working tree state.
[ok: non-zero exit]

--- 2) stash on feat/a with dirty file ---
Switched to a new branch 'feat/a'
✔ Stashed on 'feat/a' (4b19021)
  ↳ message: dub stash: feat/a @ 2026-05-24T21:13:08.249Z
  ↳ run 'dub stash pop' on 'feat/a' to restore, or 'dub stash pop --on <branch>' to move it.

--- 3) stash list (1 entry) ---
● 0: feat/a  stash@{0}  2026-05-24T21:13:08.249Z
    ↳ dub stash: feat/a @ 2026-05-24T21:13:08.249Z

--- 4) pop on different branch refused ---
Switched to a new branch 'feat/b'
✖ Stash was created on 'feat/a' but you are on 'feat/b'.

What you can do:
  1. Run 'dub stash pop --on feat/a' to checkout 'feat/a' first.
  2. Run 'dub stash pop --force' to apply on 'feat/b' anyway.
  3. Run 'dub stash list' to see the recorded branch context.
[ok: refused with hint]

--- 5) pop with --on feat/a checks out + applies ---
✔ Switched to 'feat/a'
✔ Popped stash on 'feat/a'
  ↳ message: dub stash: feat/a @ 2026-05-24T21:13:08.249Z
wip.txt contents: aaa

--- 6) list should be empty after pop ---
No dub stash entries recorded.

--- 7) --force pop onto different branch ---
✔ Stashed on 'feat/a' (352621f)
  ↳ message: dub stash: feat/a @ 2026-05-24T21:13:09.461Z
  ↳ run 'dub stash pop' on 'feat/a' to restore, or 'dub stash pop --on <branch>' to move it.
Switched to branch 'feat/b'
✔ Popped stash on 'feat/b' (originally on 'feat/a')
  ↳ message: dub stash: feat/a @ 2026-05-24T21:13:09.461Z
wip.txt on feat/b after force pop: aaa
bbb

--- 8) custom message ---
Switched to branch 'feat/a'
✔ Stashed on 'feat/a' (9dfde9c)
  ↳ message: wip: custom msg
  ↳ run 'dub stash pop' on 'feat/a' to restore, or 'dub stash pop --on <branch>' to move it.
● 0: feat/a  stash@{0}  2026-05-24T21:13:09.983Z
    ↳ wip: custom msg

--- 9) dangling: drop stash outside dub, then pop ---
Dropped stash@{0} (9dfde9c96547f951a79b3442d114c72130d394d6)
✖ Recorded stash for 'feat/a' (9dfde9c) is no longer in 'git stash list'.

What you can do:
  1. It was likely dropped or popped outside DubStack — run 'dub stash list' to see remaining entries.
  2. Run 'git stash list' to inspect the current raw stash stack.
  3. Run 'dub stash pop' again to try the next entry.
[ok: dangling error]
No dub stash entries recorded.

--- 10) MCP tools/list includes new tools ---
mcp tools containing stash: ['dubstack.stash', 'dubstack.stash-pop', 'dubstack.stash-list']

=== END ===
```

## Acceptance criteria — all satisfied

| AC | Status | Evidence |
|---|---|---|
| `packages/cli/src/commands/stash.ts` with push/pop/list subcommands | ✓ | Steps 2, 4, 3 above |
| Branch tracking via `.git/dubstack/stash-log.json` | ✓ | Step 3 lists recorded branch context |
| Branch-mismatch refusal with `--on`/`--force` overrides | ✓ | Steps 4, 5, 7 |
| Tests for each path | ✓ | `stash.test.ts` (14 tests), `stash-log.test.ts` (5 tests) |
| Docs at `apps/docs/content/docs/commands/stash.mdx` | ✓ | File added + meta.json updated |

## Specific test paths from the issue

- Stash on A, pop on A: works → Step 5 (after --on) and the same-branch test in `stash.test.ts`.
- Stash on A, pop on B without flags: refused with hint → Step 4.
- Stash on A, `dub stash pop --on B`: checkout B then pop → Step 5.
- List shows recent stashes with branch context → Steps 3, 8.

## Non-goals confirmed unchanged

- No undo entry added (stash is its own rollback mechanism via `git stash pop`).
- No PR / remote interaction (local-only command).
- No worktree-checkout skipping (no branch mutation).

## Risks / follow-ups

- Stash log is best-effort metadata; the underlying `git stash` stack remains authoritative. A corrupt log file is silently treated as empty (test coverage in `stash-log.test.ts`).
- A user who runs `git stash pop` outside DubStack will leave a dangling log entry. Step 9 shows the next `dub stash pop` surfaces the dangling entry, auto-removes it, and the user can simply retry.
