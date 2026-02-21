# Merge Workflow Guardrails Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add safe, low-error merge workflows for stacked PR users, including merge-order enforcement, guided merge automation, and post-merge recovery.

**Architecture:** Introduce three complementary layers: (1) CI merge-order gate based on DubStack PR metadata, (2) an in-CLI guided merge command (`merge-next`/`land`) that merges only the next safe PR and performs maintenance, and (3) a standalone post-merge repair command (`post-merge`) for manual merge recovery. Reuse existing state/sync/submit infrastructure and `gh` integration.

**Tech Stack:** TypeScript (ESM), commander, vitest, GitHub CLI (`gh`), GitHub Actions.

---

### Task 1: Merge-order metadata and guard command

**Files:**
- Modify: `src/lib/pr-body.ts`
- Modify: `src/lib/pr-body.test.ts`
- Modify: `src/lib/github.ts`
- Modify: `src/lib/github.test.ts`
- Create: `src/commands/merge-check.ts`
- Create: `src/commands/merge-check.test.ts`
- Modify: `src/index.ts`

**Step 1: Write failing tests**
- Add metadata parsing tests for DubStack PR metadata extraction.
- Add merge-check command tests for:
  - pass on non-stacked/no-metadata PR
  - pass when `prev_pr` is merged
  - fail when `prev_pr` is not merged

**Step 2: Run targeted tests and verify failures**
- Run:
  - `pnpm test src/lib/pr-body.test.ts`
  - `pnpm test src/commands/merge-check.test.ts`

**Step 3: Implement minimal code**
- Add `parseDubstackMetadata(...)` helper.
- Add GitHub helpers for PR lookup/state by PR number.
- Implement `merge-check` command logic and CLI wiring.

**Step 4: Re-run tests**
- Run:
  - `pnpm test src/lib/pr-body.test.ts`
  - `pnpm test src/commands/merge-check.test.ts`

### Task 2: Post-merge maintenance command

**Files:**
- Create: `src/commands/post-merge.ts`
- Create: `src/commands/post-merge.test.ts`
- Modify: `src/lib/github.ts`
- Modify: `src/lib/github.test.ts`
- Modify: `src/index.ts`

**Step 1: Write failing tests**
- `post-merge` should:
  - remove contiguous bottom merged branches from stack metadata
  - re-parent remaining branches
  - retarget open PR bases to new parents
  - support dry-run preview

**Step 2: Run targeted tests and verify failures**
- Run: `pnpm test src/commands/post-merge.test.ts`

**Step 3: Implement minimal code**
- Add GitHub base-retarget helper.
- Implement post-merge cleanup + retarget logic.
- Add CLI command `dub post-merge`.

**Step 4: Re-run tests**
- Run: `pnpm test src/commands/post-merge.test.ts`

### Task 3: Guided safe merge command (`merge-next`/`land`)

**Files:**
- Create: `src/commands/merge-next.ts`
- Create: `src/commands/merge-next.test.ts`
- Modify: `src/lib/github.ts`
- Modify: `src/lib/github.test.ts`
- Modify: `src/index.ts`

**Step 1: Write failing tests**
- `merge-next` should:
  - select the next mergeable PR (lowest branch in current path)
  - merge it via GitHub
  - invoke post-merge maintenance
  - support dry-run

**Step 2: Run targeted tests and verify failures**
- Run: `pnpm test src/commands/merge-next.test.ts`

**Step 3: Implement minimal code**
- Add GitHub merge helper.
- Implement command `dub merge-next` with alias `dub land`.

**Step 4: Re-run tests**
- Run: `pnpm test src/commands/merge-next.test.ts`

### Task 4: CI merge-order workflow guard

**Files:**
- Create: `.github/workflows/merge-order.yml`
- Modify: `README.md`
- Modify: `QUICKSTART.md`
- Modify: `.agents/skills/dubstack/SKILL.md`
- Modify: `.agents/skills/dubstack/references/commands.md`
- Modify: `.agents/skills/dubstack/references/workflows.md`

**Step 1: Implement workflow**
- Add a PR workflow that runs `dub merge-check --pr <number>` with `GH_TOKEN`.

**Step 2: Document how to use**
- Add merge workflow section:
  - `dub merge-next`
  - `dub post-merge`
  - merge-order guard expectations

### Task 5: Final verification

**Files:**
- No new files expected

**Step 1: Run full required validation**
- Run:
  - `pnpm test`
  - `pnpm typecheck`
  - `pnpm checks`

**Step 2: Summarize behavior and migration notes**
- Include clear operator guidance for users migrating to safer merge workflows.
