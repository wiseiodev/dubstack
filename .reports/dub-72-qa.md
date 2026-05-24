# Self-QA fallback - DUB-72

> This work item has no useful browser recording surface, so this file replaces
> the video and records deterministic proof instead.

## Why no video

DUB-72 ships a GitHub Action (`packages/retarget-action/`) plus a CLI command (`dub install retarget-action`). Neither has a browser-renderable surface:

- The Action runs on GitHub's Linux runners, triggered by `pull_request.closed`. Demoing it requires merging a real PR on GitHub, which can't be reproduced inside a local browser session.
- The CLI command is terminal-only (`dub install retarget-action` writes a YAML file). Recording a terminal is duplicative with the unit-test output.

The Action's behavior is fully exercised by 13 unit tests that mock Octokit and assert the exact API calls made for each scenario. The CLI command has 7 unit tests covering install, dry-run, force, confirm-cancel, confirm-accept, already-installed, and not-a-git-repo paths.

## What was verified

1. **Action algorithm** (13 tests, `packages/retarget-action/test/retarget.test.ts`):
   - Retargets dependents on a linear 3-deep stack when the bottom PR merges
   - Retargets only the dependent subtree on a sibling tree merge (siblings untouched)
   - Exits silently when the merged PR has no dubstack-metadata block
   - Exits silently when the PR did not actually merge
   - Logs and exits when metadata is legacy-shaped (no parent / no tree)
   - Skips dependents queued to auto-merge (in-flight protection)
   - Refreshes stale metadata when base is already correct (manual-retarget recovery — added in response to the adversarial review)
   - Skips entirely when both base and metadata are already correct
   - Continues when body rewrite fails after base update (best-effort, no rollback needed — added in response to the adversarial review)
   - Throws `RetargetPermissionsError` with a workflow hint on 403
   - Returns `no-dependents` when no open PR points at the merged branch
   - `removeBranchFromTree` correctly shifts descendant depths and leaves siblings alone

2. **Parser sync** (8 tests, `packages/retarget-action/test/parser-sync.test.ts`):
   - The bundled `pr-body-parser.ts` and the canonical `packages/cli/src/lib/pr-body.ts` produce byte-identical output (`JSON.stringify` comparison) on a shared fixture set of 8 PR bodies — linear, tree, malformed JSON, missing fields, legacy shape, etc.

3. **CLI install command** (7 tests, `packages/cli/src/commands/install.test.ts`):
   - Writes the workflow file at `.github/workflows/dubstack-retarget.yml`
   - Returns `already-installed` when content already matches
   - `--dry-run` does not touch disk
   - Confirm-prompt cancellation preserves existing content
   - Confirm-prompt acceptance overwrites
   - `--force` overwrites without prompting
   - Throws `DubError` when not in a git repo
   - Embedded template string matches the on-disk YAML source-of-truth

4. **End-to-end CLI smoke test** (manual, not committed):
   - Ran `dub install retarget-action --dry-run` inside a fresh `git init`'d directory; output showed the correct planned write path and the full YAML content
   - Ran `dub install retarget-action` (no flags) in the same directory; created `.github/workflows/dubstack-retarget.yml` with byte-identical content to `packages/cli/src/templates/retarget-action.yml`
   - Ran `node packages/retarget-action/dist/index.js` directly; failed cleanly with `::error::Input required and not supplied: github-token` (proves the bundle loads and `@actions/core.getInput({required: true})` wiring works)

5. **Build determinism**:
   - The bundled `dist/index.js` contains no absolute file paths (`grep '/Users\|/home\|file:///'` returns nothing) and no sourcemap URL.
   - CI's "dist drift" check (`.github/workflows/retarget-action-ci.yml`) will produce a clean comparison across machines.

6. **Repo gates** (all green):
   - `pnpm checks` — biome lint + format (324 files checked)
   - `pnpm typecheck` — 3 packages (docs, dubstack, dubstack-retarget-action)
   - `pnpm test` — 986 tests across the workspace (965 cli + 21 retarget-action)

## Evidence

- Final adversarial-review-respond commit: see git diff in this branch
- Unit-test output: `pnpm --filter dubstack-retarget-action test` → 21 passed (2 files)
- CLI test output: `pnpm --filter dubstack test` → 965 passed (101 files)
- Workspace test output: `pnpm test` → all 6 turbo tasks successful
- Bundle smoke test: `node packages/retarget-action/dist/index.js` errors with the expected "Input required" message
- The committed `dist/index.js` is 1065 KB minified ESM; biome's 1 MiB size limit was carved out via `biome.json` `files.includes` to keep `pnpm checks` green without raising the global limit

## Follow-up flag

None. Acceptance criteria from the DUB-72 issue description are all satisfied:

- [x] `packages/retarget-action/` workspace exists with the spec'd file layout
- [x] `action.yml` declares `runs.using: node24`, `main: dist/index.js`, single `github-token` input
- [x] `pnpm --filter dubstack-retarget-action build` produces `dist/index.js` via `@vercel/ncc`
- [x] `dist/index.js` is committed (the global `dist` ignore was negated for this path)
- [x] `parser-sync.test.ts` asserts byte-equivalent output
- [x] Linear stack (3-deep, bottom merged) — covered
- [x] Sibling tree (middle merged, child retargeted, siblings unchanged) — covered
- [x] No-metadata PR — covered
- [x] Legacy metadata — covered
- [x] `dub install retarget-action` — implemented with confirm-on-diff, `--dry-run`, `--force`
- [x] `.github/workflows/retarget-action-ci.yml` — lints, typechecks, tests, verifies dist freshness
- [x] Docs at `apps/docs/content/docs/guides/github-action-retarget.mdx`
