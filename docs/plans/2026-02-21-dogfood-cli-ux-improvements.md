# Dogfood CLI UX Improvements Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Improve DubStack's self-serve UX so users can diagnose and recover from common stack/submit/sync issues without assistant help.

**Architecture:** Extend existing command modules with focused preflight/diagnostic helpers (`submit`, `doctor`, `prune`, `ready`) and safer sync orchestration. Keep behavior changes covered by command-level unit tests and minimal CLI wiring updates in `src/index.ts`.

**Tech Stack:** TypeScript (ESM), commander, vitest, existing `src/lib/*` helpers.

---

### Task 1: Submit preflight and dry-run clarity

**Files:**
- Modify: `src/commands/submit.ts`
- Modify: `src/commands/submit.test.ts`
- Modify: `src/index.ts`

**Step 1: Write failing tests**
- Add tests for:
  - default/current-path submit does not fail on sibling branch elsewhere in stack
  - branching error includes parent + child names and concrete remediation commands
  - dry-run summary text does not claim pushes happened
  - `--fix` behavior in stack mode falls back to current-path when safe

**Step 2: Run submit tests and verify failures**
- Run: `pnpm test src/commands/submit.test.ts`

**Step 3: Implement minimal submit changes**
- Add submit planning helper that supports scope (`current-path` vs `stack`).
- Keep root-branch guardrails and linearity validation.
- Improve dry-run summary/result formatting semantics.
- Add `--path <current|stack>` and `--fix` in CLI wiring.

**Step 4: Re-run submit tests**
- Run: `pnpm test src/commands/submit.test.ts`

### Task 2: Doctor and ready command surface

**Files:**
- Create: `src/commands/doctor.ts`
- Create: `src/commands/doctor.test.ts`
- Create: `src/commands/ready.ts`
- Create: `src/commands/ready.test.ts`
- Modify: `src/index.ts`

**Step 1: Write failing tests**
- `doctor` detects:
  - in-progress operations
  - missing tracked local branches
  - submit branching blockers
  - remote/local drift
- `ready` reports health + submit preflight outcome for current path.

**Step 2: Run new command tests and verify failures**
- Run: `pnpm test src/commands/doctor.test.ts src/commands/ready.test.ts`

**Step 3: Implement minimal command logic**
- `doctor`: structured checks + actionable fix commands.
- `ready`: compose doctor + submit preflight helper and produce one checklist result.
- Wire `dub doctor` and `dub ready`.

**Step 4: Re-run tests**
- Run: `pnpm test src/commands/doctor.test.ts src/commands/ready.test.ts`

### Task 3: Prune stale tracked branches workflow

**Files:**
- Create: `src/commands/prune.ts`
- Create: `src/commands/prune.test.ts`
- Modify: `src/index.ts`

**Step 1: Write failing tests**
- Preview mode reports stale tracked branches without mutating state.
- `--apply` removes stale tracked branch metadata.
- Supports current-stack scope and `--all`.

**Step 2: Run prune tests and verify failures**
- Run: `pnpm test src/commands/prune.test.ts`

**Step 3: Implement minimal prune logic**
- Detect stale tracked branches by local/remote presence.
- Return preview + applied results with safe defaults.
- Wire `dub prune [--apply] [--all]`.

**Step 4: Re-run tests**
- Run: `pnpm test src/commands/prune.test.ts`

### Task 4: Safer sync defaults and recovery output

**Files:**
- Modify: `src/commands/sync.ts`
- Modify: `src/commands/sync.test.ts`
- Modify: `src/index.ts`

**Step 1: Write failing tests**
- Default sync behavior does not restack unless explicitly requested.
- Sync restack conflict/failure emits clear recovery guidance.
- Sync attempts to restore original branch only when no active operation is in progress.

**Step 2: Run sync tests and verify failures**
- Run: `pnpm test src/commands/sync.test.ts`

**Step 3: Implement minimal sync orchestration changes**
- Make restack opt-in by default.
- Add robust try/finally branch restoration behavior.
- Improve error text with concrete next commands (`dub continue` / `dub abort`).

**Step 4: Re-run sync tests**
- Run: `pnpm test src/commands/sync.test.ts`

### Task 5: Docs updates for self-serve recovery

**Files:**
- Modify: `README.md`
- Modify: `QUICKSTART.md`
- Modify: `AGENTS.md`
- Modify: `CONTRIBUTING.md`

**Step 1: Add docs for new workflows**
- Include `doctor`, `ready`, `prune`, submit path/fix behavior.
- Add stale branch recovery decision tree and commands.

**Step 2: Run verification suite**
- Run:
  - `pnpm test`
  - `pnpm typecheck`
  - `pnpm checks`

### Task 6: Final validation and summary

**Files:**
- No additional edits expected

**Step 1: Validate no unintended behavior drift**
- Review changed files and tests for scope control.

**Step 2: Summarize implementation + residual risks**
- Provide command examples and migration notes for users.
