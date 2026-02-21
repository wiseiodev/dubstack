# AGENTS.md

Guidance for AI coding agents working in this repository.

## 1) Project Overview

- Project: `dubstack`
- Type: TypeScript CLI (ESM) for stacked git branch workflows
- Main entrypoint: `src/index.ts`
- Core commands: `create`, `restack`, `submit`/`ss`, `undo`, `co`, `modify`, `skills`
- State storage: `.git/dubstack/*` inside the target git repository

## 2) Environment And Tooling

- Node: `>=22` (required)
- Package manager: `pnpm` (`pnpm@10.29.1` in `package.json`)
- Test runner: `vitest`
- Lint/format: `biome`
- Build tool: `tsup`

Use these commands from the repo root:

- `pnpm install`
- `pnpm test`
- `pnpm typecheck`
- `pnpm checks`
- `pnpm checks:fix`
- `pnpm build`

## 3) Repository Structure

- CLI wiring: `src/index.ts`
- Command implementations: `src/commands/*.ts`
- Shared logic: `src/lib/*.ts`
- Unit tests:
  - `src/**/*.test.ts`
  - `test/**/*.test.ts`
- Agent skills shipped by this repo:
  - `skills/dubstack`
  - `skills/dub-flow`

## 4) Coding Conventions

- Follow existing TypeScript style in this repo:
  - tabs for indentation
  - double quotes
  - ESM imports
- Keep command behavior user-facing and explicit via `DubError` messages.
- Prefer small pure helpers in `src/lib/*` over large command files.
- Avoid adding new dependencies unless necessary.
- Keep all changes source-first in `src/`; do not hand-edit generated output.

## 5) Behavioral Expectations To Preserve

- `create` auto-initializes state via `ensureState(...)`.
- `restack` and `submit` require valid tracked stack state and should fail clearly when context is invalid.
- `submit` only supports linear stacks (one child per parent path during submit flow).
- `undo` remains single-level.
- Error text is part of UX and often asserted in tests; change carefully.

## 6) Testing Expectations

For non-trivial changes, run at least:

1. `pnpm test`
2. `pnpm typecheck`
3. `pnpm checks`

If behavior/output changed, add or update tests near the changed code:

- command logic: `src/commands/*.test.ts`
- library logic: `src/lib/*.test.ts`
- cross-command scenarios: `test/**/*.test.ts`

## 7) Git And PR Guidance

- Use conventional commit style where possible (`feat:`, `fix:`, `docs:`, etc.).
- Keep commits scoped and readable.
- If command UX changes, update docs (`README.md`, `QUICKSTART.md`) in the same PR.
- If skill workflows change, update corresponding files under `skills/`.

## 8) Agent Workflow For This Repo

When implementing a task:

1. Read relevant command + lib files first.
2. Make minimal focused edits.
3. Add/update tests for changed behavior.
4. Run verification commands.
5. Summarize changes with file paths and any follow-up risks.

When reviewing code:

- Prioritize regressions in stack state handling, git command safety, submit flow, and conflict/recovery paths.

