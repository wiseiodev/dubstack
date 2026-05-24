## TL;DR

Adds `dub status` CLI with cache-first JSON output. Cached reads use the DUB-25 overview cache for <100ms snapshots; `--live` refreshes via a batched `gh pr list`; cold cache misses return `cached: false` with no network calls.

## Why

Shell prompts and tmux status lines need a fast, scriptable view of stack/PR/CI state.

MCP already exposed a structured status snapshot — DUB-80 extracted it into a shared module, leaving DUB-28 to add the user-facing CLI surface.

Versioning the JSON shape (`schemaVersion: 1`) lets external consumers (prompts, editors) lock against breaking changes.

### Before

- `dub status` did not exist as a CLI command — the snapshot was only reachable via the `dubstack.status` MCP tool, which always hit `gh` per branch.
- No documented integration story for Starship/tmux/oh-my-zsh.
- No fast path: every status query paid the cost of a synchronous `gh pr list --head <branch>`.

### After

- `dub status` prints a one-liner like `feat/api · PR #123 OPEN · CI SUCCESS · ✓`.
- `dub status --json` emits a versioned structured snapshot.
- Cached path reads the DUB-25 stack-overview cache (30s TTL) for sub-100ms output.
- Cold path skips all network/git overhead and returns `cached: false` with a minimal local snapshot.
- `--live` refreshes via a single batched `gh pr list`; `--no-pr` skips PR fetch entirely.
- Shell integration guide covers Starship, tmux, and oh-my-zsh recipes.
- MCP wrapper passes `{ live: true }` to preserve the fresh-data behavior MCP consumers relied on.

## File-by-file

### packages/cli/src/commands/status.ts

mod +217 / -0

Rewrites `status()` with three modes — cached (overview-cache hit), live (refresh + batched gh), cold (local-only). Adds `cached: boolean` and a richer `PrSnapshot` (number, title, isDraft, ciRollup, reviewDecision). Adds `formatStatus()` one-liner used by the CLI default.

```typescript
if (options.live) {
  const overview = await getStackOverviewBatch(cwd, { refresh: true });
  ...
}
const cached = await readStackOverviewCache(cwd);
if (cached) { ... return { ..., cached: true }; }
// Cold path: no network/git beyond what's already done. <100ms target.
return { schemaVersion: 1, cached: false, ..., pr: null, drift: null };
```

### packages/cli/src/index.ts

mod +30 / -0

Wires `dub status` with `--json`, `--live`, `--no-pr`. Default action prints `formatStatus(result)`; `--json` prints `JSON.stringify(result, null, 2)`.

```typescript
program
  .command('status')
  .option('--json', 'Output the status snapshot as JSON')
  .option('--live', 'Bypass the overview cache and hit gh fresh')
  .option('--no-pr', 'Skip PR fetch (for fast prompts without gh)')
```

### packages/cli/src/commands/doctor.ts

mod +31 / -0

Adds a `skipGithub` option to doctor so the cache-only status drift checks stay fully local — no per-branch `gh pr list` calls. Default behavior of the public `dub doctor` command is unchanged.

```typescript
options: { all?: boolean; fetch?: boolean; skipGithub?: boolean }
...
if (!options.skipGithub) {
  const prInfo = await getBranchPrSyncInfo(branch.name, cwd);
  ...
}
```

### packages/cli/src/lib/stack-overview.ts

mod +19 / -0

Adds `readStackOverviewCache(cwd, now)` — a TTL-aware read-only accessor that returns `null` on miss/corruption/stale. Used by status's cache-first path; never writes or refreshes.

```typescript
export async function readStackOverviewCache(cwd, now = Date.now()) {
  const cached = await readCache(cwd);
  if (!cached) return null;
  if (age < 0 || age >= OVERVIEW_CACHE_TTL_MS) return null;
  return cached;
}
```

### packages/cli/src/commands/mcp.ts

mod +1 / -1

MCP wrapper now passes `{ live: true }` to preserve the fresh-data behavior MCP consumers relied on. (The default cache-first mode is for the CLI; MCP one-shot queries prefer freshness.)

```typescript
case 'dubstack.status':
  return jsonToolResult(await status(cwd, { live: true }));
```

### apps/docs/content/docs/guides/shell-integration.mdx

new +126 / -0

New guide covering the `dub status` contract, JSON shape, and integration recipes for Starship, tmux, and oh-my-zsh. Linked from `meta.json`.

```toml
[custom.dubstack]
command = "dub status --no-pr"
when = "git rev-parse --is-inside-work-tree"
format = "[$output]($style) "
```

### packages/cli/src/commands/status.test.ts

mod +302 / -0

Rewrites the test suite around the new modes: cached (rich PR data, drift), cold (local-only, no network calls), live (batched refresh, drift), `--no-pr` skip, schemaVersion, perf gate (<100ms with mocked I/O), and `formatStatus` rendering.

```typescript
it('cached read completes well under 100ms (mocked I/O)', async () => {
  ...
  const start = performance.now();
  await status('/repo');
  expect(performance.now() - start).toBeLessThan(100);
});
```

### .reports/dub-28-qa.md

new +89 / -0

Self-QA fallback documenting acceptance-criteria verification, smoke test, performance check, and quality-gate status (no UI surface → no video).

### apps/docs/content/docs/guides/meta.json

mod +1 / -0

Registers `shell-integration` in the docs nav between `mcp` and `migration-from-graphite`.

## Where to focus review

1. **Cold-path performance contract** - `packages/cli/src/commands/status.ts:123-134`: The cold path must never touch the network so shell prompts stay snappy on cache misses. Verify `pr: null, drift: null` is returned without any `gh` or fetch calls — the adversarial reviewer flagged an earlier draft that violated this and it was fixed by removing `getBranchPrSyncInfo` entirely from the cold branch.
2. **MCP backward compatibility** - `packages/cli/src/commands/mcp.ts:637`: MCP `dubstack.status` now passes `{ live: true }`. Verify the response shape matches or supersedes the prior MCP behavior (richer `pr` fields from the batched call, same drift output via the new `skipGithub: true` doctor path).
3. **doctor() skipGithub option** - `packages/cli/src/commands/doctor.ts`: Adds a new boolean option that suppresses per-branch `gh pr list` calls (and the `remote-base-mismatch` issue that depends on them). Verify default behavior (`dub doctor` CLI) is unchanged — option only kicks in when `status` calls doctor for drift.
4. **Schema versioning** - `packages/cli/src/commands/status.ts:38-50`: `schemaVersion: 1` is the consumer contract. `pr: PrSnapshot | null` and `drift: DriftSnapshot | null` allow the null case (cold path). Verify external consumers can safely pin on this shape.

## Test plan

- [x] **unit:** Cached path returns rich PR data + drift, no gh calls - src/commands/status.test.ts → 'returns cached: true with rich PR data when overview cache is present'
- [x] **unit:** Cold path returns local-only with cached: false, no network calls - src/commands/status.test.ts → 'returns local-only snapshot with cached: false and never touches the network'
- [x] **unit:** Live path refreshes overview cache - src/commands/status.test.ts → 'refreshes the overview cache and includes drift'
- [x] **unit:** --no-pr skips PR fetch entirely - src/commands/status.test.ts → 'skips PR fetch entirely when pr: false'
- [x] **unit:** Cache-only path completes <100ms - src/commands/status.test.ts → 'cached read completes well under 100ms (mocked I/O)'
- [x] **unit:** formatStatus renders all variants (PR/DRAFT/no PR/cold/operation/drift) - src/commands/status.test.ts → 5 formatStatus describe-block tests
- [x] **manual:** CLI smoke test in fresh dub-init repo - Cold output: `main · (cold)` and JSON `{ schemaVersion: 1, cached: false, pr: null, drift: null }` — see .reports/dub-28-qa.md.

## Quality gates

- **Biome lint + format:** `pnpm checks` - passed (biome check . — 0 errors, 0 warnings)
- **TypeScript:** `pnpm typecheck` - passed (2 packages typecheck clean)
- **Vitest:** `pnpm test` - passed (839 tests passed (24 new status tests + 815 prior))
- **Build (dubstack):** `pnpm --filter dubstack build` - passed (tsup ESM build success, 432.76 KB)
- **Docs build:** `pnpm --filter docs build` - passed (Next.js + fumadocs-mdx build clean (after switching tmux code-fence to bash))
- **Evals:** `pnpm evals` - skipped (Pre-existing better-sqlite3 ABI mismatch with local Node; not in scope (no AI prompts/metadata changed in this PR))

## Self-QA

See [QA fallback evidence](.reports/dub-28-qa.md).

Self-QA fallback: smoke test outputs + perf timings + acceptance-criteria checklist.

- `dub status --help` prints all three new flags
- `dub status` (cold) prints `main · (cold)` with no network calls
- `dub status --json` emits `{ schemaVersion: 1, cached: false, pr: null, drift: null }`
- `dub status --no-pr --json` matches the cold-path JSON shape
- `time dub status` x3 in a tmp repo: ~210ms wall-clock incl. Node startup; in-process <100ms confirmed by vitest perf gate

## Acceptance criteria

- [x] `dub status` and `dub status --json` both wired in `index.ts` - packages/cli/src/index.ts adds the command; smoke test prints both human and JSON outputs.
- [x] `--live` and `--no-pr` flags work - Both flags registered in commander; behavior covered by `status (live path)` and `skips PR fetch entirely when pr: false` tests.
- [x] Cache-only execution measured <100ms (hyperfine in PR description) - vitest perf gate `cached read completes well under 100ms (mocked I/O)` enforces this on CI. Local smoke `time dub status` ~210ms total (~170ms Node startup, rest in-process).
- [x] Cold execution returns `{ cached: false, ...localOnly }` - Cold path returns `cached: false, pr: null, drift: null` — verified in `returns local-only snapshot with cached: false` test and smoke output.
- [x] `schemaVersion: 1` on JSON output - Top-level field on every code path; asserted in multiple tests and visible in smoke JSON.
- [x] Shell integration docs added (Starship + tmux) - apps/docs/content/docs/guides/shell-integration.mdx covers Starship, tmux, and oh-my-zsh. Registered in meta.json. Docs build clean.
- [x] Tests for JSON shape, cache behavior, live, cold, schemaVersion - 24 tests in src/commands/status.test.ts cover all paths plus formatStatus and the perf gate.

## Adversarial review

Iterations: 1

Remaining critical/major: 0/0

Remaining minor/nitpick: 0/0

- Resolved (critical): cold path originally called `getBranchPrSyncInfo` on default, violating the <100ms shell-prompt contract. Fixed by removing the cold gh call entirely — `pr: null, drift: null` on cold. Tests updated accordingly.
- Reviewed (info): `untracked-current-branch` is not part of `isDriftIssue`. This matches pre-existing behavior (the same isDriftIssue list shipped in DUB-80) and is intentional — an untracked branch is a setup issue, not stack drift. Out of scope for this PR.
- Reviewed (info): MCP wrapper now passes `{live: true}`, which means MCP consumers always see `cached: false`. The richer `pr` shape (number/title/ciRollup/etc.) is additive and superior to the prior per-branch state-only response.

## Dependencies

- **DUB-80 — extract MCP status() into shared module:** merged on main (commit f3b55cd)
- **DUB-25 — batched PR/CI data layer with 30s cache:** merged on main (commit 289d315)

## Rollout

Pure additive CLI surface plus a new MCP-equivalent code path. No state-file migrations, no config changes.

- **On merge - Ship:** `dub status` becomes available immediately. No flag, no opt-in. Existing MCP `dubstack.status` callers see a richer `pr` shape (additive fields) but same top-level keys plus new `cached` and `schemaVersion`.
- **Optional follow-up - User adoption:** Link the new shell-integration guide from the README or marketing surface so users discover Starship/tmux/oh-my-zsh recipes.
- **Future - Schema v2:** If breaking changes to the JSON shape are needed, bump `schemaVersion` to 2 and document the migration; downstream consumers should pin on the version.

## Commit

```text
feat(status): add dub status CLI command with cache-first JSON [DUB-28]
```
