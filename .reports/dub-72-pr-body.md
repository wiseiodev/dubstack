## TL;DR

New `packages/retarget-action` GitHub Action reads the v1 `dubstack-metadata` block on a merged PR, finds open PRs whose `parent` matches, and retargets each via Octokit — updating base ref, rewriting the metadata block + visible stack table, and posting an explanatory comment. New `dub install retarget-action` writes the workflow template into `.github/workflows/dubstack-retarget.yml` with `--dry-run`, `--force`, and confirm-on-diff. The bundled parser stays in sync with the canonical CLI parser via a cross-running vitest. CI re-runs ncc to fail on dist/ drift.

## Why

When a Dubstack PR merges, its dependents still point at the deleted branch as their base. Users had to fix this manually.

Tier 8 of the project roadmap calls for a stateless co-pilot server. This Action is the simpler, zero-infra variant: same outcome, no webhook receiver or persistent state required.

DUB-21 (v1 metadata schema + `parseDubstackMetadata`) landed on main, making the Action's parsing trivially reusable.

### Before

- After a stack PR merges, dependent PRs target a now-deleted branch and refuse to merge without manual `base` updates.
- Each dependent's stored `dubstack-metadata` continues to name the merged-and-deleted parent, confusing downstream tooling.
- Teams either retargeted manually via the GitHub UI or ran `dub submit` again from a local checkout — both error-prone.

### After

- The Action runs on every `pull_request.closed` where `merged == true`; it self-no-ops on non-Dubstack PRs.
- Dependents are retargeted to the merged PR's parent (or trunk for root-of-stack merges); their metadata + visible stack table are rewritten in place.
- `dub install retarget-action` makes setup a one-liner that drops a pinned workflow file into the repo.
- Manual-retarget recovery: if a teammate moved the base via the GitHub UI but left the metadata stale, the Action refreshes the metadata without double-updating the base.

## File-by-file

### packages/retarget-action/src/retarget.ts

new +339 / -0

Pure retarget routine; all GitHub access flows through a `RetargetClient` interface so unit tests inject a recording mock. Implements all edge cases from the issue: not-merged, no-metadata, legacy-shape, no-dependents, auto-merge-in-flight, already-retargeted, 403 permissions. Body rewrite is best-effort — if it fails after the base update, the workflow still succeeds and logs a warning (the next `dub submit` self-heals the metadata).

```typescript
const baseAlreadyCorrect = pr.base.ref === newBase;
const metadataAlreadyCorrect = meta.parent === mergedMetadata.parent;
if (baseAlreadyCorrect && metadataAlreadyCorrect) {
  log.info(`Skipping #${pr.number}, already retargeted to ${newBase}`);
  skipped.push({ number: pr.number, reason: 'already retargeted' });
  continue;
}
```

### packages/retarget-action/src/pr-body-parser.ts

new +116 / -0

Self-contained copy of `parseDubstackMetadata` + types from packages/cli/src/lib/pr-body.ts. Required because the published Action must ship as a single bundled dist/index.js without workspace-relative imports.

### packages/retarget-action/src/main.ts

new +66 / -0

Action entrypoint. Reads `github-token`, builds the Octokit client, hands off to `runRetarget`. On `RetargetPermissionsError`, surfaces a setFailed message that includes the exact YAML snippet to add for permissions.

### packages/retarget-action/src/octokit.ts

new +66 / -0

Thin Octokit wrapper applying @octokit/plugin-retry. Exposes only the four methods the retarget routine needs, keeping the unit-test mock surface tiny.

### packages/retarget-action/action.yml

new +18 / -0

Action manifest pinned to `runs.using: node24`. Node 20 deprecation completes June 2 2026; Node 24 is the current default LTS on GitHub Actions runners as of 2026-05-24.

```yaml
runs:
  using: node24
  main: dist/index.js
```

### packages/retarget-action/test/retarget.test.ts

new +376 / -0

13 unit tests covering every algorithm branch — linear stack, sibling tree, no-metadata, legacy-shape, auto-merge, already-retargeted, metadata-only repair (added in response to adversarial review), body-rewrite failure, 403 permissions, no-dependents, plus removeBranchFromTree shape correctness.

### packages/retarget-action/test/parser-sync.test.ts

new +101 / -0

Cross-runs the bundled parser and packages/cli's canonical parser against 8 fixtures (linear, tree, no-metadata, malformed JSON, missing-required-field, legacy-shape, etc.) and asserts JSON-stringified equivalence. Fails CI if the two implementations ever drift.

### packages/retarget-action/dist/index.js

new +10 / -0

Committed ncc bundle. GitHub Marketplace serves the Action from the tagged tree, so dist/ must live in git. The repo .gitignore was extended with a negation rule (`!packages/retarget-action/dist`) to override the default `dist` ignore.

### packages/cli/src/commands/install.ts

new +123 / -0

New `install` recipe shell. Initial recipe is `retarget-action`; the switch is exhaustive (`never` check) so future recipes (DUB-73 webhook) plug in cleanly. The workflow template is embedded as a string constant; a test asserts it stays byte-identical to the source-of-truth at packages/cli/src/templates/retarget-action.yml.

### packages/cli/src/index.ts

mod +75 / -0

Wires the `dub install <recipe>` Commander subcommand with `--dry-run` and `--force` flags. Uses readline for the overwrite-confirm prompt, matching the existing pattern in commands/untrack.ts.

### .github/workflows/retarget-action-ci.yml

new +49 / -0

Path-scoped CI workflow for packages/retarget-action and packages/cli/src/lib/pr-body.ts. Last step re-runs ncc and `git diff --quiet` on the dist/ tree to fail the build if a contributor forgot to commit the rebuilt bundle.

### apps/docs/content/docs/guides/github-action-retarget.mdx

new +151 / -0

Docs page covering install, how it works, permissions, edge cases, outputs, troubleshooting, and limitations. Slotted into the guides sidebar between shell-integration and migration-from-graphite.

### .gitignore

mod +4 / -0

Negation rule un-ignores packages/retarget-action/dist/ so the committed Marketplace bundle stays tracked.

```gitignore
node_modules
dist
# The retarget Action's dist/ MUST stay tracked — GitHub Marketplace serves
# the Action from the tagged tree, so dist/index.js has to exist there.
!packages/retarget-action/dist
!packages/retarget-action/dist/**
```

### biome.json

mod +5 / -1

Excludes packages/retarget-action/dist from biome scanning. The minified bundle is 1.0 MiB which hits biome's default file-size limit; carving out the bundle is cleaner than raising the limit project-wide.

## Where to focus review

1. **Tree-removal correctness** - `packages/retarget-action/src/retarget.ts: removeBranchFromTree`: Drops the merged branch from a DFS-ordered tree array and shifts descendants up one depth. The descendants block is identified as the contiguous suffix at depth > mergedDepth. A bug here would produce a misshapen tree on the retargeted PR's metadata; the unit test covers a 5-node tree with a sibling to guard against off-by-one.
2. **Already-retargeted vs. metadata-only repair** - `packages/retarget-action/src/retarget.ts:137-180`: The adversarial review surfaced that the original short-circuit skipped the metadata rewrite even when a teammate had manually retargeted the base via the GitHub UI (leaving the embedded metadata stale). The fix splits the check into base-vs-metadata and refreshes whichever is stale; a new test asserts the metadata-only-repair path.
3. **Best-effort body rewrite** - `packages/retarget-action/src/retarget.ts:165-184`: After updatePullBase succeeds, body + comment failures only emit a core.warning. Rationale: the base move is the critical operation; the metadata regenerates on the next `dub submit` from the source-of-truth state. A test confirms the action still reports `retargeted` when the body rewrite throws.
4. **Parser-sync fixture coverage** - `packages/retarget-action/test/parser-sync.test.ts`: Cross-runs the bundled and canonical parsers against 8 fixtures. Make sure the fixtures include both common shapes (linear/tree) and adversarial inputs (malformed JSON, missing fields, legacy shape) — otherwise drift between the two implementations could slip through CI.

## Test plan

- [x] **unit:** packages/retarget-action retarget core (13 tests) - pnpm --filter dubstack-retarget-action test → 21 passed (2 files)
- [x] **unit:** packages/retarget-action parser-sync (8 fixture-driven tests) - Same test run; assertions check JSON.stringify(bundledParse(body)) === JSON.stringify(canonicalParse(body)) for each fixture
- [x] **unit:** packages/cli install command (7 tests) - pnpm --filter dubstack test → 965 passed (101 files); install.test.ts covers installed/already-installed/dry-run/cancel/accept/force/not-a-git-repo/template-sync
- [x] **manual:** End-to-end CLI smoke (install --dry-run + install + bundle loads) - .reports/dub-72-qa.md section 4

## Quality gates

- **biome (lint + format):** `pnpm checks` - passed (Checked 324 files in 177ms. No fixes applied.)
- **TypeScript typecheck (3 packages):** `pnpm typecheck` - passed (3 successful, 3 total via turbo (docs, dubstack, dubstack-retarget-action))
- **vitest test suite:** `pnpm test` - passed (6 successful, 6 total via turbo (986 tests across the workspace))
- **ncc bundle builds clean:** `pnpm --filter dubstack-retarget-action build` - passed (dist/index.js (1065kB) emitted; only index.js + package.json in dist/)

## Self-QA

See [QA fallback evidence](.reports/dub-72-qa.md).

Deterministic proof via unit tests + a fresh-repo CLI smoke test. See .reports/dub-72-qa.md.

- Action: linear-stack bottom merge → child retargets, grandchild untouched
- Action: sibling-tree merge → only the dependent subtree retargets
- Action: no-metadata, not-merged, legacy-metadata, auto-merge-in-flight, already-retargeted, body-rewrite-fails, 403 permissions paths
- Parser sync: 8 PR-body fixtures across linear/tree/edge cases
- CLI: dub install retarget-action --dry-run in /tmp/dub-72-smoke produced expected planned write
- CLI: dub install retarget-action (no flags) wrote .github/workflows/dubstack-retarget.yml byte-identical to template
- Bundle: node dist/index.js failed with expected 'Input required: github-token' error

## Acceptance criteria

- [x] packages/retarget-action/ workspace exists with the file layout from the issue - Tree includes action.yml, package.json, tsconfig.json, README.md, src/{main,retarget,pr-body-parser,octokit}.ts, test/{retarget,parser-sync}.test.ts + helpers + 3 fixtures, dist/index.js
- [x] action.yml declares runs.using: node24, main: dist/index.js, single github-token input - packages/retarget-action/action.yml lines 12-18
- [x] pnpm --filter dubstack-retarget-action build produces dist/index.js via @vercel/ncc - ncc 0.38.4 emits 1065kB dist/index.js (single ESM bundle)
- [x] dist/index.js is committed - git status shows it tracked; .gitignore was extended with a negation rule for this path
- [x] parser-sync.test.ts asserts byte-for-byte equivalent output - 8 cross-runs of bundled vs canonical parsers compare JSON.stringify outputs; all pass
- [x] Linear 3-deep stack retarget — verified by unit test - retargets dependents on a linear 3-deep stack when the bottom PR merges
- [x] Sibling tree retarget (only dependent subtree) — verified by unit test - retargets only the dependent subtree on a sibling tree merge
- [x] No-op gracefully on PRs without metadata - exits silently when the merged PR has no dubstack-metadata block
- [x] No-op gracefully on legacy metadata - logs and exits when metadata is legacy-shaped (no parent / no tree)
- [x] dub install retarget-action with confirm-on-diff, --dry-run, --force - packages/cli/src/commands/install.ts + 7 unit tests covering each flag and confirm path
- [x] CI workflow lints, typechecks, tests, and verifies dist/ freshness - .github/workflows/retarget-action-ci.yml steps 4-7
- [x] Docs at apps/docs/content/docs/guides/github-action-retarget.mdx cover install, usage, troubleshooting - 151-line guide; entry added to guides/meta.json

## Adversarial review

Iterations: 1

Remaining critical/major: 0/0

Remaining minor/nitpick: 0/0

- MAJOR (resolved): partial-failure inconsistency when updatePullBase succeeded but updatePullBody/postComment threw. Fixed by wrapping body+comment in try/catch that emits core.warning and continues; the next `dub submit` self-heals the metadata.
- MAJOR (resolved): the 'already retargeted' short-circuit skipped the metadata rewrite even when a teammate had manually moved the base via the GitHub UI (stale metadata). Fixed by splitting the check into base-correct vs. metadata-correct; added a new test that asserts the metadata-only-repair path.
- INFO (verified, no change): bundle determinism — grepped dist/index.js for absolute paths and sourcemap URLs; none present. CI's dist-drift check is safe across machines.
- INFO (already correct): action.yml runs.using: node24 — verified against actions/runner release notes; Node 20 deprecation completes 2026-06-02; node24 is the current default LTS as of 2026-05-24.

## Dependencies

- **DUB-21 (v1 metadata schema + parseDubstackMetadata):** Done — landed on main
- **DUB-71 (parseable PR body metadata contract):** Done — superseded; no longer blocking
- **@actions/github@^9.1.1 (uses @octokit/core@7):** Pinned
- **@octokit/plugin-retry@^7.2.1:** Pinned
- **@vercel/ncc@^0.38.4 (build-time only):** Pinned

## Rollout

PR opens against main. CI must pass (lint, typecheck, test, dist-drift). After merge, the maintainer cuts a v1 tag and publishes to GitHub Marketplace (release task, out of scope for this PR per the issue).

- **On merge - Land on main:** Standard squash-style landing per repo convention.
- **Post-merge - Tag v1:** git tag v1 && git push --tags. Marketplace serves the Action from the tagged tree.
- **Post-merge - Publish on Marketplace:** Create the listing on GitHub Marketplace using the action.yml metadata. This is a one-time manual step per the issue's 'out of scope for this issue' section.
- **On first downstream install - User runs `dub install retarget-action`:** Writes .github/workflows/dubstack-retarget.yml into the consuming repo; user commits + pushes; the Action runs on the next merge.

## Commit

```text
feat(retarget-action): github action + dub install for stack retargeting on merge [DUB-72]
```
