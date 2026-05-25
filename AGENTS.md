# AGENTS.md

Guidance for AI coding agents working in this repository.

## 1) Project Overview

- Project: `dubstack`
- Type: Turborepo monorepo — TypeScript CLI (ESM) for stacked git branch workflows + docs app
- Main entrypoint: `packages/cli/src/index.ts`
- Core commands: `create`, `restack`, `submit`/`ss`, `merge-next`/`land`, `post-merge`, `undo`, `co`, `modify`, `skills`
- State storage: `.git/dubstack/*` inside the target git repository

## 2) Environment And Tooling

- Node: `>=22` (required)
- Package manager: `pnpm` (`pnpm@10.29.1` in `package.json`)
- Monorepo orchestrator: `turbo` (root scripts delegate via turbo)
- Test runner: `vitest`
- Lint/format: `biome` (runs repo-wide from root via `pnpm checks`)
- Build tool: `tsup` (CLI package)

Use these commands from the repo root:

- `pnpm install`
- `pnpm test`
- `pnpm typecheck`
- `pnpm checks`
- `pnpm checks:fix`
- `pnpm check:all`
- `pnpm evals`
- `pnpm evals:watch`
- `pnpm evals:export`
- `pnpm build`

## 3) Repository Structure

- Root configs: `turbo.json`, `tsconfig.json` (base), `biome.json`, `pnpm-workspace.yaml`
- CLI package (`packages/cli/`):
  - CLI wiring: `packages/cli/src/index.ts`
  - Command implementations: `packages/cli/src/commands/*.ts`
  - Shared logic: `packages/cli/src/lib/*.ts`
  - Unit tests: `packages/cli/src/**/*.test.ts` and `packages/cli/test/**/*.test.ts`
- Docs app: `apps/docs/` (Next.js App Router with Fumadocs)
- Agent contributor docs: `.agents/README.md`, `.agents/styleguide.md`, `.agents/patterns/*.md`
- Agent skills shipped by this repo:
  - `skills/dubstack`
  - `skills/dub-flow`
- Project-only agent skills:
  - `.agents/skills/dub-flow-evals`

## 4) Coding Conventions

- Follow existing TypeScript style in this repo:
  - spaces for indentation (2 spaces)
  - single quotes
  - kebab-case file names
  - ESM imports
- Read `.agents/styleguide.md` and relevant `.agents/patterns/*.md` before making structural changes.
- Keep command behavior user-facing and explicit via `DubError` messages.
- Prefer small pure helpers in `packages/cli/src/lib/*` over large command files.
- Avoid adding new dependencies unless necessary.
- Keep all changes source-first in `packages/cli/src/`; do not hand-edit generated output.

## 5) Behavioral Expectations To Preserve

- `create` auto-initializes state via `ensureState(...)`.
- `restack` and `submit` require valid tracked stack state and should fail clearly when context is invalid.
- `submit` defaults to downstack (current branch + ancestors); use `--upstack`, `--stack`, or `--branch <name>` for other scopes. Scope flags are mutually exclusive. Legacy `--path current|stack` still works in v1.x with a deprecation warning.
- `undo` is multi-level via a 20-entry ring buffer at `.git/dubstack/undo-log.json`; `dub redo` replays the most recently undone entry. Mutating commands save an entry before mutation; saves are best-effort (filesystem failures are swallowed).
- Error text is part of UX and often asserted in tests; change carefully.

## 6) Testing Expectations

**ALWAYS** run these before considering any task complete — no exceptions:

1. `pnpm checks` — lint + format (auto-fix with `pnpm checks:fix`)
2. `pnpm typecheck` — type checking
3. `pnpm test` — unit tests

All three must pass. Do not skip any. Do not consider work done until all pass.

If AI metadata generation or prompts changed, also run `pnpm evals`.

When you want the full local gate in one command, run `pnpm check:all`.

If behavior/output changed, add or update tests near the changed code:

- command logic: `packages/cli/src/commands/*.test.ts`
- library logic: `packages/cli/src/lib/*.test.ts`
- cross-command scenarios: `packages/cli/test/**/*.test.ts`

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

1. Read relevant command + lib files in `packages/cli/src/` first.
2. Make minimal focused edits.
3. Add/update tests for changed behavior.
4. Run verification commands.
5. Summarize changes with file paths and any follow-up risks.

When reviewing code:

- Prioritize regressions in stack state handling, git command safety, submit flow, and conflict/recovery paths.
