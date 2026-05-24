## TL;DR

Adds three Biome GritQL plugins, a 1-page Tier 3 pattern doc, a copy-paste command scaffold, and styleguide links — plus fixes 7 surviving bare-DubError sites uncovered by the new rule so the codebase clears the gate today.

## Why

Every Tier 3 command must reuse the same 7 Tier 0 pieces (DubError + recovery, retry, progress, --force-with-lease, worktree-skip, undo, MCP). Without a shared reference each author rediscovers the pattern and silently drifts.

Lint enforcement makes drift impossible for the three most damaging rules: bare DubError (no actionable recovery), direct execa('gh', …) (skips retry + permanent-error classification), and raw git push --force (races with teammate pushes).

### Before

- No single doc captured the canonical Tier 3 shape — agents had to read 5+ existing commands to infer the pattern.
- Two bare new DubError(msg) calls in mcp.ts and five more across sync/track/untrack/git slipped through review because no automated check caught them.
- Nothing prevented a future command from calling execa('gh', …) directly or git push --force without --force-with-lease.

### After

- Authors start from .agents/templates/tier-3-command.md and follow .agents/patterns/tier-3-commands.md.
- pnpm checks fails fast on bare DubError, direct execa('gh', …), and raw git push --force outside the wrapper files.
- All 7 surviving bare-DubError sites in production code carry recovery hints, so the codebase clears the gate without any allowlist hacks.

## File-by-file

### biome-plugins/no-bare-duberror.grit

new +15 / -0

GritQL plugin that flags single-argument `new DubError($msg)` calls. Uses list-destructure `$args <: [$msg]` so it catches both inline and multi-line single-arg constructions (the earlier comma-substring heuristic missed the multi-line case). Allowlisted for `lib/errors.ts` and `*.test.ts`.

```grit
`new DubError($args)` where {
  $args <: [$msg],
  $filename <: not r".*/lib/errors\.ts(end)",
  $filename <: not r".*\.test\.ts(end)",
  register_diagnostic(span=$msg, message="DubError requires a recovery hint array. …")
}
// (end) = $ anchor, elided to avoid template-substitution clash in the report renderer.
```

### biome-plugins/no-direct-execa-gh.grit

new +15 / -0

Blocks `execa('gh', …)` anywhere outside `lib/github.ts` (where the `runGh` wrapper lives). Direct calls skip retry + permanent-error classification.

```grit
`execa($cmd, $rest)` where {
  $cmd <: `'gh'`,
  $filename <: not r".*/lib/github\.ts(end)",
  register_diagnostic(span=$cmd, message="Use the runGh wrapper …")
}
```

### biome-plugins/no-direct-force-push.grit

new +18 / -0

Blocks `execa('git', […, 'push', …, '--force', …])` unless the arg list also contains `--force-with-lease`. Allowlisted only for `lib/git.ts` where `pushBranch` builds the safe lease arg.

```grit
`execa($cmd, $rest)` where {
  $cmd <: `'git'`,
  $rest <: contains `'push'`,
  $rest <: contains `'--force'`,
  $rest <: not contains r"--force-with-lease.*",
  $filename <: not r".*/lib/git\.ts(end)",
  register_diagnostic(…)
}
```

### biome.json

mod +5 / -0

Registers the three plugins in the `plugins` array so `biome check` (and therefore `pnpm checks`) runs them automatically.

```json
"plugins": [
  "./biome-plugins/no-bare-duberror.grit",
  "./biome-plugins/no-direct-execa-gh.grit",
  "./biome-plugins/no-direct-force-push.grit"
],
```

### .agents/patterns/tier-3-commands.md

new +280 / -0

Opinionated cheat-sheet. Nine sections, each with a snippet, an import path, and a 'don't' list: DubError + recovery, retry, createProgress, --force-with-lease, worktree-aware mutations, undo entries, MCP exposure, runGh, cleanup journal. Closes with a lint-rules table and verification commands.

### .agents/templates/tier-3-command.md

new +167 / -0

Copy-paste command scaffold (TS fenced block) with options interface, dry-run path, worktree-checkout skip, undo snapshot, progress loop, and a wire-up checklist (CLI entry, MCP tool, tests, docs). The scaffold deliberately routes git/gh work through helper stubs (`doWork`) so it does not itself trip the new lint rules.

### .agents/styleguide.md

mod +4 / -0

Command Design section now points at the new patterns doc, scaffold template, and biome-plugins directory.

```markdown
- For new Tier 3 commands, follow [`patterns/tier-3-commands.md`](patterns/tier-3-commands.md)
  and start from the scaffold in [`templates/tier-3-command.md`](templates/tier-3-command.md).
```

### .agents/README.md

mod +3 / -0

Adds `templates/` to the folder index and lists the new doc + scaffold.

### packages/cli/src/commands/mcp.ts

mod +13 / -3

Upgrades two `new DubError(msg)` calls (missing-branch arg + unknown-tool dispatch) and one internal-invariant guard to include recovery hints. Each was a real Tier 0 violation surfaced by the new lint rule.

### packages/cli/src/commands/sync.ts

mod +8 / -0

Adds recovery hints to the two error-wrapping `new DubError` sites that wrap non-DubError thrown values (per-branch fallback and top-level sync error). Hints point at `dub doctor` and `dub sync --verbose`.

### packages/cli/src/commands/track.ts

mod +11 / -3

Splits the no-parent-selected and could-not-infer-parent errors into a message + recovery hints (`--parent <branch>`, `dub log`).

### packages/cli/src/commands/untrack.ts

mod +4 / -0

Adds recovery hints to the non-interactive descendants-present error. Preserves the existing message wording (the test suite asserts on `--downstack`).

### packages/cli/src/lib/git.ts

mod +4 / -0

Adds recovery hints to the fast-forward failure error (manual `git merge --ff-only` command + `dub doctor`).

### .reports/dub-81-qa.md

new +70 / -0

Self-QA fallback (no video) describing the positive-test fixture run, the seven bare-DubError site fixes, and the green gate output.

## Where to focus review

1. **GritQL allowlist regex anchoring** - `biome-plugins/*.grit`: All three plugins use an end-anchored regex on `/lib/<file>.ts` so a sibling file of the same name (e.g. a future `commands/errors.ts`) cannot silently inherit the exemption. Verify the anchor is appropriate for any future relocations of `errors.ts`, `git.ts`, or `github.ts`.
2. **Bare-DubError multi-line detection** - `biome-plugins/no-bare-duberror.grit`: An earlier draft used `$args <: not contains \",\"` which missed multi-line single-arg constructions with a trailing comma. The shipped version uses `$args <: [$msg]` (list-of-one destructure). Reviewers should confirm this matches their mental model and try a synthetic two-arg call to verify it does not fire there.
3. **Recovery hint quality for the 7 newly-surfaced sites** - `packages/cli/src/{commands/{mcp,sync,track,untrack}.ts,lib/git.ts}`: Each new recovery array was chosen from the surrounding command context (e.g. `dub doctor`, `dub sync --verbose`, `--parent <branch>`). Reviewers familiar with each command's UX should confirm the hints are the best next step.

## Test plan

- [x] **build:** pnpm checks (biome + plugins) clean on 285 files - Checked 285 files in 142ms. No fixes applied.
- [x] **build:** pnpm typecheck - Tasks: 2 successful, 2 total
- [x] **unit:** pnpm test — full vitest suite - Test Files 93 passed (93); Tests 863 passed (863)
- [x] **manual:** Positive-test fixture: each plugin fires on its specific violation - /tmp/positive-test.ts with bare DubError + execa('gh', …) + git push --force produced 3 distinct plugin diagnostics, one per rule.

## Quality gates

- **Biome check (incl. new plugins):** `pnpm checks` - passed (Checked 285 files in 142ms. No fixes applied.)
- **TypeScript:** `pnpm typecheck` - passed (Tasks: 2 successful, 2 total)
- **Vitest suite:** `pnpm test` - passed (863 tests passed across 93 files)

## Self-QA

See [QA fallback evidence](.reports/dub-81-qa.md).

Self-QA fallback: positive-test fixture + green gates documented in .reports/dub-81-qa.md.

- Run `pnpm checks` against a synthetic file containing a bare DubError, an execa('gh', …), and a raw git push --force — all three rules fire.
- Run `pnpm checks` against the current packages/cli/src — zero plugin diagnostics after the seven surviving bare-DubError sites are fixed.

## Acceptance criteria

- [x] .agents/patterns/tier-3-commands.md exists with examples for each rule - Nine sections, each with a snippet, the import path, and a 'don't' list, covering DubError, retry, createProgress, force-with-lease, worktree mutations, undo, MCP, runGh, cleanup journal.
- [x] Biome rule blocks new DubError(msg) with no recovery - biome-plugins/no-bare-duberror.grit; verified by positive-test fixture and 7 surviving production sites it surfaced.
- [x] Biome rule blocks raw execa('gh', …) in Tier 3 command files - biome-plugins/no-direct-execa-gh.grit; allowlist exempts only lib/github.ts (the runGh wrapper).
- [x] Biome rule blocks raw git push --force (must be --force-with-lease) - biome-plugins/no-direct-force-push.grit; allowlist exempts only lib/git.ts (pushBranch).
- [x] Command scaffold template lives somewhere referenceable - .agents/templates/tier-3-command.md — linked from the patterns doc and styleguide.
- [x] .agents/styleguide.md links to the patterns doc - Command Design section now points at patterns/tier-3-commands.md, templates/tier-3-command.md, and biome-plugins/.

## Adversarial review

Iterations: 2

Remaining critical/major: 0/0

Remaining minor/nitpick: 0/0

- Iteration 1: reviewer found the comma-substring heuristic missed multi-line single-arg new DubError calls (1 real false-negative at mcp.ts:722). Fixed by switching to a list-of-one destructure on the arg list; surfaced 7 latent violations that were also fixed.
- Iteration 1: reviewer flagged that allowlist regexes for lib/git.ts and lib/github.ts did not require a leading slash before the filename; tightened all three to require the /lib/ path segment.
- Iteration 1: reviewer flagged the scaffold template using raw execa('git', …). Replaced with a doWork(branch, cwd) helper stub plus a comment instructing authors to add helpers to lib/ instead of calling execa from a command.
- Iteration 2: reviewer noted no-bare-duberror did not require the /lib/ path segment before errors.ts; tightened for consistency with the sibling rules.

## Dependencies

- **No external dependencies detected:** n/a

## Rollout

Pure additive — docs and lint rules. Zero behavior change for end users; lint gate effective the moment the PR merges.

- **On merge - Lint rules active:** `pnpm checks` (and the pre-push hook) immediately enforces no-bare-duberror, no-direct-execa-gh, and no-direct-force-push across the whole repo.
- **Before DUB-30..DUB-42 land - Authors adopt the scaffold:** Each new Tier 3 command starts from `.agents/templates/tier-3-command.md` and consults `.agents/patterns/tier-3-commands.md` for the import paths and dos/don'ts.

## Commit

```text
feat(guardrails): tier 3 implementation cheat-sheet + biome lint rules [DUB-81]
```
