# Dub UX Command Parity Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Improve DubStack ergonomics for non-power-git users by adding Graphite-style repair and orientation commands, plus UX upgrades to existing high-traffic commands.

**Architecture:** Add new command modules for tracking/recovery/orientation and extend existing state + command orchestration with strict invariants and safe prompts. Implement command behavior as small library-backed operations with deterministic non-interactive behavior and explicit force gates.

**Tech Stack:** TypeScript (ESM), Commander, Execa/git/gh CLI wrappers, Vitest, Biome.

---

## Scope

### Phase 1 (P0 recovery foundations)

- New commands:
  - `dub track [branch] [--parent <branch>]`
  - `dub untrack [branch] [--downstack]`
  - `dub delete [branch] [--upstack|--downstack] [--force] [--quiet]`
  - `dub continue`
  - `dub abort`
  - `dub parent`, `dub children`, `dub trunk`

### Phase 2 (P1 UX upgrades)

- `dub submit` preview/confirm messaging improvements
- `dub log` filtering and readability modes

### Phase 3 (P2 advanced stack surgery)

- `dub move` and/or `dub reorder`

## State and Invariant Requirements

Required invariants after each mutation:
1. every non-root branch must reference an existing parent in the same stack
2. no cycles in parent pointers
3. root branches remain `type: "root"` and `parent: null`
4. deleting or untracking a branch must leave descendants in a valid state (or explicitly include them in operation)

## Task Breakdown

### Task 1: Add branch graph utility helpers for ancestry/descendant operations

**Files:**
- Create: `src/lib/graph.ts`
- Test: `src/lib/graph.test.ts`

**Steps:**
1. Write failing tests for descendant traversal and cycle detection.
2. Run targeted tests and verify failure.
3. Implement minimal helpers:
   - `getDescendants(...)`
   - `getAncestors(...)`
   - `assertAcyclic(...)`
4. Re-run tests and confirm pass.
5. Commit.

### Task 2: Implement `track` core library functions

**Files:**
- Create: `src/lib/track.ts`
- Test: `src/lib/track.test.ts`

**Steps:**
1. Write failing tests for:
   - tracking an untracked branch
   - re-parenting an already tracked branch
   - invalid parent rejection
2. Run targeted tests and verify failure.
3. Implement minimal functions:
   - `trackBranch(...)`
   - `validateTrackParent(...)`
4. Re-run tests and confirm pass.
5. Commit.

### Task 3: Implement `dub track` command wiring

**Files:**
- Create: `src/commands/track.ts`
- Modify: `src/index.ts`
- Test: `src/commands/track.test.ts`

**Steps:**
1. Write failing command tests for current branch and explicit branch behavior.
2. Run targeted tests and verify failure.
3. Implement command behavior with:
   - optional branch arg
   - optional `--parent`
   - interactive parent prompt (TTY only)
4. Re-run tests and confirm pass.
5. Commit.

### Task 4: Implement `untrack` core and command

**Files:**
- Create: `src/lib/untrack.ts`
- Create: `src/commands/untrack.ts`
- Modify: `src/index.ts`
- Test: `src/lib/untrack.test.ts`
- Test: `src/commands/untrack.test.ts`

**Steps:**
1. Write failing tests for untracking leaf and recursive downstack behavior.
2. Run targeted tests and verify failure.
3. Implement minimal behavior with safe prompts unless `--downstack` or non-interactive deterministic mode.
4. Re-run tests and confirm pass.
5. Commit.

### Task 5: Implement stack-aware `delete`

**Files:**
- Create: `src/lib/delete.ts`
- Create: `src/commands/delete.ts`
- Modify: `src/index.ts`
- Test: `src/lib/delete.test.ts`
- Test: `src/commands/delete.test.ts`

**Steps:**
1. Write failing tests for:
   - single branch delete
   - `--upstack` and `--downstack` expansion
   - forced delete behavior
   - state re-parenting correctness
2. Run targeted tests and verify failure.
3. Implement command with dry prompt path and deterministic non-interactive rules.
4. Re-run tests and confirm pass.
5. Commit.

### Task 6: Implement operation continuation and abort framework

**Files:**
- Create: `src/lib/operation-state.ts`
- Create: `src/commands/continue.ts`
- Create: `src/commands/abort.ts`
- Modify: `src/index.ts`
- Test: `src/lib/operation-state.test.ts`
- Test: `src/commands/continue.test.ts`
- Test: `src/commands/abort.test.ts`

**Steps:**
1. Write failing tests for missing operation state, active rebase continuation, and abort flows.
2. Run targeted tests and verify failure.
3. Implement minimal operation-state abstraction and command handlers.
4. Re-run tests and confirm pass.
5. Commit.

### Task 7: Implement orientation commands (`parent`, `children`, `trunk`)

**Files:**
- Create: `src/commands/parent.ts`
- Create: `src/commands/children.ts`
- Create: `src/commands/trunk.ts`
- Modify: `src/index.ts`
- Test: `src/commands/parent.test.ts`
- Test: `src/commands/children.test.ts`
- Test: `src/commands/trunk.test.ts`

**Steps:**
1. Write failing tests for tracked and untracked branch contexts.
2. Run targeted tests and verify failure.
3. Implement concise command output + clear remediation for untracked contexts.
4. Re-run tests and confirm pass.
5. Commit.

### Task 8: Upgrade submit UX output and preflight guidance

**Files:**
- Modify: `src/commands/submit.ts`
- Modify: `src/commands/submit.test.ts`

**Steps:**
1. Add failing tests for improved output summaries and actionable failure messages.
2. Implement minimal output/report layer upgrades.
3. Re-run tests and confirm pass.
4. Commit.

### Task 9: Add `log` mode flags (`--stack`, `--all`, `--reverse`)

**Files:**
- Modify: `src/commands/log.ts`
- Modify: `src/index.ts`
- Test: `src/commands/log.test.ts`

**Steps:**
1. Add failing tests for each mode.
2. Implement minimal filtering + ordering behavior.
3. Re-run tests and confirm pass.
4. Commit.

### Task 10: Documentation and skill updates for new commands

**Files:**
- Modify: `README.md`
- Modify: `QUICKSTART.md`
- Modify: `skills/dubstack/SKILL.md`
- Modify: `skills/dubstack/references/commands.md`
- Modify: `skills/dubstack/references/workflows.md`

**Steps:**
1. Update docs with new command syntax and recovery playbooks.
2. Validate command examples against CLI wiring.
3. Commit.

## Verification Gates

Run after each major phase and before merge:

```bash
pnpm test
pnpm typecheck
pnpm checks
```

## Acceptance Criteria

Phase 1 complete when:
- all P0 commands exist, tested, and documented
- non-interactive behavior is deterministic and safe
- destructive actions require explicit force or confirmation

Phase 2 complete when:
- submit and log UX upgrades are shipped with tests

Phase 3 complete when:
- move/reorder strategy is implemented with conflict-safe behavior and guidance

## Deferred Decisions

- exact `move` syntax (`--onto` vs interactive editor-first)
- whether to add `doctor` command in same track or separate reliability initiative
