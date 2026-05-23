# Autonomous Ship Report Template

Use this template for:
`docs/reports/<date>-autoship-report.md`

Before writing this report, ensure the directory exists:
`mkdir -p docs/reports`

## 1. Overview

- Date:
- Task:
- Task source:
- Assignee:
- PR link:

## 2. Scope Completed

- Primary objective:
- Acceptance criteria completed:
- Out-of-scope items intentionally deferred:

## 3. Assumptions Made (No User Questions Mode)

- Assumption 1:
- Assumption 2:

## 4. Plan Review Council (Architect, Prefer Claude)

- Major feedback:
- Plan changes applied:
- Risks mitigated after revision:

## 5. Implementation Summary

- Files changed:
- Core logic updates:
- Pattern/standards alignment notes:

## 6. Quality Gates - Pass 1 (Sequential)

- `pnpm checks`:
- `pnpm typecheck`:
- `pnpm test`:
- `pnpm evals` (only if AI metadata/prompt outputs changed):
- Warnings observed: (must be `0`)

## 7. Code Review Council (Staff Engineer, Prefer Claude+Codex+Gemini)

- Critical issues found:
- Minor issues found:
- Fixes applied:
- Feedback rejected and why:

## 8. Quality Gates - Pass 2 (Sequential)

- `pnpm checks`:
- `pnpm typecheck`:
- `pnpm test`:
- `pnpm evals` (only if AI metadata/prompt outputs changed):
- Warnings observed: (must be `0`)

## 9. Follow-up Work

- Deferred items:

## 10. PR Checks Watch Loop

- First `gh pr checks --watch` result:
- Issues found:
- Fixes applied:
- Number of watch/fix cycles:
- Final checks status:

## 11. Copilot PR Review Resolution

- Copilot review present: (`yes`/`no`)
- Total Copilot comments:
- Comments resolved:
- Rejected comments and rationale:
- Additional code/test changes required:

## 12. Final Status

- Ready for merge:
- Remaining blockers:
- Handoff notes:
