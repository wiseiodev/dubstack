---
name: autoship
description: Use when the user wants fully autonomous delivery in this repo from the next ready bd issue through implementation, verification, review, and PR follow-through.
---

# Autoship

Run an end-to-end autonomous ship cycle for `dubstack`. Do not pause for confirmation unless blocked.

## Non-Negotiables

- Operate autonomously and avoid routine follow-up questions; make reasonable assumptions and record them.
- Keep issue tracking in `bd` only.
- Start with `bd ready --json`, pick work deterministically, and claim it.
- Run two `review-council` passes:
  - Plan pass: `Architect` persona, prefer `claude`.
  - Code pass: `Staff Engineer` persona, prefer `claude` + `codex` + `gemini`.
- Run repository quality gates twice (before and after council-driven fixes).
- Require zero failures and zero warnings.
- Run quality checks strictly sequentially (never parallel).
- Use this repository's required quality-gate sequence:
  - `pnpm checks`
  - `pnpm typecheck`
  - `pnpm test`
- If AI metadata or prompt generation changed, also run `pnpm evals`.
- Maintain autonomy for git/PR operations: branch, commit, push, submit PR, and update the branch without waiting for extra confirmation.
- Work only in the current checkout (no git worktrees).
- Produce a written summary report for the user.

## Workflow

1. Select and claim work:
   - Run `bd ready --json`.
   - Pick the highest-priority unblocked issue (tie-breaker: oldest issue).
   - Run `bd update <id> --claim --json`.
   - Run `bd show <id> --json` and capture acceptance criteria.

2. Build an implementation plan:
   - Ensure plan directory exists: `mkdir -p .dispatch`.
   - Write a plan file at `.dispatch/<id>-implementation-plan.md`.
   - Include: scope, assumptions, risks, step-by-step tasks, test strategy, and rollback notes.

3. Plan review council (round 1):
   - Use the `review-council` skill.
   - Persona: `Architect`.
   - Prefer `claude`; if unavailable, use the best available reviewer and note the limitation.
   - Revise the plan based on feedback and save changes.

4. Implement:
   - Execute plan steps in order.
   - Maintain existing repo patterns and code standards.
   - Add/update tests for changed behavior near the edited code.
   - If new follow-up work is discovered, create linked bead issues using
     `--deps discovered-from:<current-id>`.

5. Quality gates (pass 1):
   - Run checks strictly one at a time. Start the next check only after the
     current check fully exits.
   - Never run multiple quality checks concurrently.
   - If a check is slow, keep waiting. Do not interrupt or spawn extra checks.
   - Execute this exact verification sequence, one command at a time:
     - `pnpm checks`
     - `pnpm typecheck`
     - `pnpm test`
   - If AI metadata or prompt generation changed:
     - `pnpm evals`
   - If repository policy requires wrappers/sub-agents for checks, still run the
     same checks in this exact order, sequentially.
   - Treat any warning as a failure.

6. Code review council (round 2):
   - Use the `review-council` skill.
   - Persona: `Staff Engineer` with strict review tone ("hard-ass staff engineer").
   - Prefer council members: `claude`, `codex`, and `gemini`.
   - If one member is unavailable, continue with available reviewers and record the gap.
   - Apply all valid fixes and document any rejected feedback with rationale.

7. Quality gates (pass 2):
   - Re-run the exact same full verification set from step 5.
   - Do not proceed until every check passes with zero warnings.

8. Create stacked PR:
   - Use a non-interactive autonomous `dub-flow` path for branch + commit + submit (for example: `dub flow --ai -a -y`).
   - Ensure PR description includes scope, test evidence, and bead reference(s).
   - If `dub-flow` is unavailable, fall back to direct non-interactive commands (`dub create ...` + `dub ss`) and record why.

9. Post-PR CI watch and fix loop:
   - Run `gh pr checks --watch` and wait for completion.
   - If any check fails or reports issues:
     - Fix the issues in code.
     - Re-run the full local verification set sequentially (same commands as
       step 5/7).
     - Update the PR branch.
     - Run `gh pr checks --watch` again.
   - Repeat until all PR checks complete successfully.

10. Copilot review comments:
   - Ensure a Copilot review exists on the PR.
   - After CI is green, review Copilot comments and resolve all valid feedback.
   - Use the `review-pr-comments` skill in autonomous mode (do not pause for
     user confirmation) to process unresolved review threads.
   - For rejected comments, provide technical rationale in-thread before
     resolving.
   - If code changes were made while addressing comments, re-run local quality
     checks sequentially and run `gh pr checks --watch` again.

11. Produce final report:
   - Ensure report directory exists: `mkdir -p docs/reports`.
   - Create `docs/reports/<date>-<id>-autoship-report.md` using
     [report-template.md](references/report-template.md).
   - Include: selected bead, plan changes from council, implementation summary,
   quality gate evidence (both passes), review-council findings + resolutions,
     CI watch cycles, Copilot review comment resolutions, PR link, and any
     follow-up beads.
   - Share a concise handoff summary with the user.

## Failure Handling

- If blocked by missing credentials, missing CLI tools, or infrastructure failure,
  stop and provide a blocker report with exact failing command, error, and next action.
- Do not skip required steps, quality gates, or council rounds.
