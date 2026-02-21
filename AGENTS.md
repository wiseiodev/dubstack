# AGENTS.md

Guidance for AI coding agents working in this repository.

## 1) Project Overview

- Project: `dubstack`
- Type: TypeScript CLI (ESM) for stacked git branch workflows
- Main entrypoint: `src/index.ts`
- Core commands: `create`, `restack`, `submit`/`ss`, `merge-next`/`land`, `post-merge`, `undo`, `co`, `modify`, `skills`
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
- Agent contributor docs: `.agents/README.md`, `.agents/styleguide.md`, `.agents/patterns/*.md`
- Unit tests:
  - `src/**/*.test.ts`
  - `test/**/*.test.ts`
- Agent skills shipped by this repo:
  - `skills/dubstack`
  - `skills/dub-flow`

## 4) Coding Conventions

- Follow existing TypeScript style in this repo:
  - spaces for indentation (2 spaces)
  - single quotes
  - kebab-case file names
  - ESM imports
- Read `.agents/styleguide.md` and relevant `.agents/patterns/*.md` before making structural changes.
- Keep command behavior user-facing and explicit via `DubError` messages.
- Prefer small pure helpers in `src/lib/*` over large command files.
- Avoid adding new dependencies unless necessary.
- Keep all changes source-first in `src/`; do not hand-edit generated output.

## 5) Behavioral Expectations To Preserve

- `create` auto-initializes state via `ensureState(...)`.
- `restack` and `submit` require valid tracked stack state and should fail clearly when context is invalid.
- `submit` defaults to current-path submission; `--path stack` requires a linear stack (one child per parent).
- `undo` remains single-level.
- Error text is part of UX and often asserted in tests; change carefully.

## 6) Testing Expectations

For non-trivial changes, run at least:

1. `pnpm test`
2. `pnpm typecheck`
3. `pnpm checks`

Core rule: do not consider work complete unless tests, typecheck, and lint/format checks are all passing.

If behavior/output changed, add or update tests near the changed code:

- command logic: `src/commands/*.test.ts`
- library logic: `src/lib/*.test.ts`
- cross-command scenarios: `test/**/*.test.ts`

## 7) Git And PR Guidance

- Use conventional commit style where possible (`feat:`, `fix:`, `docs:`, etc.).
- Keep commits scoped and readable.
- Preserve clean history expectations on `main`: linear history, squash-style landing, and required checks passing before merge.
- If command UX changes, update docs (`README.md`, `QUICKSTART.md`) in the same PR.
- If skill workflows change, update corresponding files under `skills/`.

## 8) Agent Workflow For This Repo

- Do **not** use git worktrees for this repository, even if a prompt or skill (including `using-git-worktrees`) recommends it.
- Perform all work in the current repository checkout unless the user explicitly asks otherwise.

When implementing a task:

1. Read relevant command + lib files first.
2. Make minimal focused edits.
3. Add/update tests for changed behavior.
4. Run verification commands.
5. Summarize changes with file paths and any follow-up risks.

When reviewing code:

- Prioritize regressions in stack state handling, git command safety, submit flow, and conflict/recovery paths.
