## TL;DR

Adds dub stash / dub stash pop / dub stash list. A Dubstack-unique branch-aware stash that refuses to apply onto a different branch than where it was created, with --on <branch> and --force overrides. Recorded in .git/dubstack/stash-log.json as a 50-entry ring buffer; pop locates the right stash@{N} by SHA so external git stash activity can't grab the wrong entry.

## Why

Plain git stash doesn't remember which branch a stash was created on. Stashing on feat/a, switching to feat/b, then popping silently applies work onto the wrong branch — a common DubStack-user footgun.

Graphite doesn't ship this; it's a real differentiator for stack-heavy workflows where users frequently switch branches mid-WIP.

### Before

- Users either remember the source branch manually or eat the cost of a bad pop and untangle the diff after.

### After

- dub stash records {sha, branch, message, createdAt}; pop refuses mismatches with both override flags in the recovery hint. dub stash list shows recorded stashes with branch context plus presence in git stash list.

## File-by-file

### packages/cli/src/commands/stash.ts

new +213 / -0

stashPush / stashPop / stashList. Push refuses on clean tree, captures git stash + records to log. Pop finds the right stash@{N} by SHA, enforces branch match with --on/--force overrides, swallows post-pop log-write failure with a warning (the next pop auto-cleans the dangling entry).

### packages/cli/src/lib/stash-log.ts

new +107 / -0

Atomic write-then-rename, 50-entry ring buffer, corrupt file → empty list (log is best-effort context, not authoritative state).

### packages/cli/src/lib/git.ts

mod +85 / -0

Adds gitStashPushIncludeUntracked, listGitStashes, gitStashPop helpers — DubError wrapping with recovery hints, SHA lookup so callers can match log entries to git refs.

### packages/cli/src/index.ts

mod +98 / -0

CLI wiring: `dub stash` parent command + `pop` and `list` subcommands, plus `--list` flag alias. Stash output highlights the source branch.

### packages/cli/src/commands/mcp.ts

mod +65 / -0

Exposes dubstack.stash (mutating), dubstack.stash-pop (mutating), dubstack.stash-list (read-only) over the MCP surface.

### packages/cli/src/commands/stash.test.ts

new +247 / -0

16 tests covering all four acceptance-criterion paths plus edge cases: same-branch pop, branch-mismatch refusal, --on <branch>, --on <current>, --on + --force precedence, --force, missing --on target, empty log, dangling auto-clean, custom message, untracked-file inclusion.

### packages/cli/src/lib/stash-log.test.ts

new +74 / -0

Ring-buffer trim at 50, corrupt-file tolerance, removal by SHA, prepend ordering.

### packages/cli/src/commands/mcp.test.ts

mod +3 / -0

tools/list assertion updated to include the three new tool names.

### apps/docs/content/docs/commands/stash.mdx

new +115 / -0

Full docs page: usage, why-it-exists, behavior for push/pop/list, flag matrix, error matrix, state-file schema, precedence rule.

### apps/docs/content/docs/commands/meta.json

mod +1 / -0

Registers stash in the docs sidebar between rename and skills.

### README.md

mod +23 / -0

New `dub stash` section above `dub undo` with quick usage examples and a link to the full docs page.

### QUICKSTART.md

mod +22 / -0

Inserts `10.5) Branch-Aware Stash` walkthrough and adds an entry to the Fast Command List.

## Where to focus review

1. **SHA-based stash lookup** - `packages/cli/src/commands/stash.ts:116`: External git stash activity (drop, pop, push) shifts stash@{N} indexes. Looking up by commit SHA avoids the wrong-stash footgun, but assumes git keeps stash commits identifiable until they're dropped — which it does.
2. **Post-pop log cleanup is non-atomic by design** - `packages/cli/src/commands/stash.ts:164`: git stash pop already removed the stash from git's stack. A subsequent log-write failure can't be rolled back, so we swallow with a warning. The next dub stash pop will surface the dangling entry, auto-remove it, and the user retries — confirmed by tests for the dangling path.
3. **Override flag precedence: --on wins over --force** - `packages/cli/src/commands/stash.ts:135`: When both are passed, --on wins. Documented in stash.mdx, covered by a dedicated test. A user passing both is most likely thinking 'put it on this specific branch'.

## Test plan

- [x] **unit:** packages/cli/src/commands/stash.test.ts (16 tests) - All push/pop/list paths plus all four issue acceptance-criterion paths + adversarial-review additions.
- [x] **unit:** packages/cli/src/lib/stash-log.test.ts (5 tests) - Ring buffer trim, corrupt-file tolerance, removal by SHA, prepend ordering.
- [x] **unit:** packages/cli/src/commands/mcp.test.ts (tools/list) - Asserts the three new tool names are exposed in tools/list ordering.
- [x] **manual:** Built-CLI end-to-end transcript in a temp repo - .reports/dub-42-qa.md captures stash, pop, --on, --force, list, dangling-entry auto-clean, and MCP tools/list verification.

## Quality gates

- **biome lint + format:** `pnpm checks` - passed (Checked 303 files in 162ms. No fixes applied.)
- **typecheck:** `pnpm typecheck` - passed (turbo: 2 successful, 2 total.)
- **tests:** `pnpm test` - passed (935 passed / 99 files passed.)
- **build:** `pnpm build` - passed (turbo: 2 successful, 2 total (FULL TURBO).)

## Self-QA

See [QA fallback evidence](.reports/dub-42-qa.md).

Built-CLI end-to-end transcript: clean-tree refusal, stash on feat/a, list, mismatched pop refusal with hint, --on feat/a, --force, custom message, dangling auto-clean, MCP tools/list verification.

- stash refuses on clean working tree
- stash on feat/a records branch + writes log
- stash list shows recorded entries with branch + ref
- pop on feat/b refused with both --on and --force hints
- pop --on feat/a checks out + applies
- pop --force applies on feat/b regardless
- stash with custom -m message
- dangling entry auto-removed when stash dropped externally
- MCP tools/list exposes dubstack.stash / stash-pop / stash-list

## Acceptance criteria

- [x] New packages/cli/src/commands/stash.ts with push, pop, list subcommands - Three exported functions wired through CLI subcommands + MCP tools.
- [x] Branch tracking via .git/dubstack/stash-log.json - stash-log.ts (ring buffer, atomic write, corrupt-tolerant); covered by stash-log.test.ts.
- [x] Branch-mismatch refusal with --on and --force overrides - stashPop's branch-mismatch DubError surfaces both flags in recovery hints; tests cover both override paths + precedence.
- [x] Tests for each path - 16 command tests + 5 lib tests; covers stash on A pop on A, A pop on B refused, A pop --on B, list shows recent stashes with branch context, plus edge cases.
- [x] Docs at apps/docs/content/docs/commands/stash.mdx - Full usage, behavior, flag/error matrix, state-file schema, precedence rule documented; meta.json updated.

## Adversarial review

Iterations: 1

Remaining critical/major: 0/0

Remaining minor/nitpick: 0/0

- Critical (resolved): log entry leak when removeStashLogEntry fails after a successful pop — now swallowed with a warning since stashPop auto-cleans dangling entries on the next invocation.
- Minor (resolved): missing test for --on <current-branch> — added.
- Minor (resolved): missing test for --on + --force precedence — added + documented in stash.mdx.

## Dependencies

- **External dependencies:** None — uses existing execa, retry, DubError, state plumbing already in lib/.

## Rollout

Pure additive feature. No state-format change in state.json; new sibling file .git/dubstack/stash-log.json is auto-created on first stash. Old clients ignore the file. Safe to roll forward and back without state migration.

- **Merge - Ship via standard squash-merge to main:** All gates green; semantic-release picks up the feat(stash) conventional commit and cuts a minor version.
- **Post-merge - Docs auto-deploy from main:** stash.mdx + README + QUICKSTART updates ship with the same merge.

## Commit

```text
feat(stash): dub stash + dub stash pop — branch-aware stashing [DUB-42]
```
