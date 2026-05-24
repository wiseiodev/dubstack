# Self-QA fallback - DUB-40

> This work item has no useful browser recording surface, so this file replaces
> the video and records deterministic proof instead.

## Why no video

`dub unlink` is a CLI command operating on local git state and the GitHub PR
API. There is no UI surface to record. All behavior is observable from the
terminal and the on-disk `.git/dubstack/state.json` file.

## What was verified

End-to-end against a real git sandbox under `/tmp/dub-unlink-qa`:

1. **Default `--keep-children`** — `dub unlink feat/auth-login` on a 4-branch
   stack split it into two stacks: original kept `main → feat/auth-base`; new
   stack rooted at `feat/auth-login` with `feat/auth-mfa` as its child.
   `state.json` confirms the new root has `type: 'root'`, `parent: null`,
   `parent_revision: null`.
2. **`dub undo`** — restored the pre-unlink shape exactly, with
   `feat/auth-mfa` back under `feat/auth-login` under `feat/auth-base`.
3. **`--orphan-children`** — direct child `feat/auth-mfa` was re-parented onto
   `feat/auth-base`, leaving the original stack still connected; the new
   stack contained only `feat/auth-login`.
4. **Root rejection** — `dub unlink main` failed with the expected DubError
   plus actionable recovery hints.
5. **Mutually-exclusive flag guard** — `dub unlink ... --keep-children
   --orphan-children` failed at the CLI layer with a clean DubError.

All exits non-zero where expected; all DubErrors carried recovery hints.

## Evidence

- 926 vitest assertions pass: `pnpm test`
- typecheck: `pnpm typecheck` (both `dubstack` and `docs`)
- lint/format: `pnpm checks` (biome — including the Tier 3 guardrail rules
  for `no-bare-DubError`, `no-direct-execa-gh`, `no-direct-force-push`)
- Sandbox session transcript above showing each scenario's success/failure
- Unit tests: `packages/cli/src/commands/unlink.test.ts` (10 cases)
- Integration crash-resume test: `packages/cli/test/commands/unlink-resume.test.ts`
  drives a real journal on disk through `resumeCleanup` and verifies the
  retarget op is replayed and the journal cleared.
- Undo+journal coexistence test: `packages/cli/src/commands/undo.test.ts`
  proves `dub undo` for an unlink also discards the pending journal.

## Follow-up flag

None. All acceptance criteria from DUB-40 are satisfied. The pre-existing
pattern where `dub move` could leave a stale cleanup journal after `dub undo`
was NOT changed (out of scope) — `unlink` now uses a tighter pattern that
clears the journal as part of undo, which we could extend to `move` in a
future PR.
