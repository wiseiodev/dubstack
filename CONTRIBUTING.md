# Contributing To DubStack

Thanks for contributing.

This project accepts contributions from both humans and coding agents. The goal is predictable, safe changes to stacked-branch workflows.

## Prerequisites

- Node `>=22`
- `pnpm` (`pnpm@10.29.1`)

Setup:

```bash
pnpm install
```

## Development Workflow

1. Read `AGENTS.md` (required for repo-specific conventions).
2. Make focused source changes in `src/`.
3. Add/update tests near the changed behavior.
4. Run verification commands:
   - `pnpm test`
   - `pnpm typecheck`
   - `pnpm checks`
5. Open a PR using the repository PR template.

Core rule: changes are not ready to merge unless all three verification commands pass.

## Using A Coding Agent

If you use Codex, Claude Code, Cursor Agent, or similar:

- Point the agent to `AGENTS.md` and `.agents/` docs first.
- Keep edits minimal and scoped to the requested behavior.
- Require tests for behavior changes, especially command output and error text.
- Do not use git worktrees in this repository unless a maintainer explicitly asks for them.
- Prefer safe, non-destructive git operations.

Recommended context for agents:

- `AGENTS.md`
- `.agents/skills/dubstack/`
- `.agents/skills/dub-flow/`

## Commit Messages (Conventional Commits)

Use conventional commit format:

```text
type(scope): short description
```

Examples:

- `feat(submit): support draft PR creation`
- `fix(restack): preserve parent mapping after rebase`
- `test(create): cover ensureState auto-init`
- `docs(contributing): add coding-agent workflow`

Common types:

- `feat`, `fix`, `docs`, `refactor`, `test`, `chore`

Optional setup for a local commit template:

```bash
git config commit.template .github/commit-template.txt
```

## Pull Requests

- Keep PRs focused and reviewable.
- Include behavioral impact and risk in PR description.
- If UX or command semantics change, update docs in the same PR (`README.md`, `QUICKSTART.md`, or `.agents/*` as needed).
