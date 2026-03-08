---
name: dub-flow
description: Use when turning staged changes into a DubStack branch, commit, and submitted PR stack with clear naming and user confirmation.
---

# DubStack PR Flow

Use this skill when a user asks to "create a PR" or "submit this" from staged changes, especially when you want the CLI path to mirror `dub flow`.

## Goal

Produce a clean, reviewable stack operation with:
1. suggested branch name
2. suggested commit message
3. suggested PR description
4. optional issue linkage
5. execution via `dub flow` when AI is available, or `dub create` + `dub submit` when manual mode is required

## Preconditions

- Current directory is a git repo.
- Staged changes exist (or user explicitly wants help staging).
- `gh` auth is configured for PR operations.
- If using AI flow, `dub config ai-assistant on` is enabled for the repo.

## Phase 1: Analyze Changes

Run:

```bash
git status --short
git diff --cached --stat
git diff --cached
git log --oneline -5
```

Capture:
- change scope (feature/fix/refactor/docs/test/chore)
- files and line impact
- likely branch scope and commit intent

If nothing is staged, stop and suggest one of:
- `git add <files>`
- `git add -A`
- use `dub create <name> -pm "..."` to stage interactively

## Phase 2: Propose Naming and Metadata

### Branch naming

Prefer:

```text
<type>/<short-kebab-scope>
```

Examples:
- `feat/auth-login`
- `fix/sync-parent-mismatch`
- `refactor/submit-body-builder`

### Commit message

Use conventional commits:

```text
type(scope): summary

optional body

optional issue link
```

If user provided issue ID (for example `A-35`), append:

```text
Completes A-35
```

### PR description guidance

- PR title should stay equal to the commit subject for squash-merge safety.
- AI-generated PR text should focus on the description body only.
- If the repo has a PR template, preserve its headings and section order.

### Template-aware metadata

If the repo has templates, use them as the formatting contract:

- PR template locations:
  - `.github/pull_request_template.md`
  - `.github/PULL_REQUEST_TEMPLATE.md`
  - `.github/PULL_REQUEST_TEMPLATE/*.md`
  - `docs/pull_request_template.md`
  - `pull_request_template.md`
- Commit template:
  - configure with `git config commit.template .gitmessage`

The first line of the commit message still must be a valid Conventional Commit subject.

## Phase 3: Confirm Before Execution

Present:
- suggested branch name
- suggested commit message
- suggested PR description
- what command you plan to run

Ask user to choose:
1. proceed
2. edit branch/message
3. cancel

## Phase 4: Execute

### Preferred AI path

```bash
dub flow --ai -a
```

- `dub flow` previews branch, commit, PR, and planned commands before mutation.
- In non-interactive terminals, add `-y` because approval prompts require a TTY.
- Use `dub f --dry-run` when you only need preview output.

### Default path (stage all)

```bash
dub create <branch-name> -am "<commit-message>"
dub ss
```

### If user requested tracked-only staging

```bash
dub create <branch-name> -um "<commit-message>"
dub ss
```

### If user requested patch/hunk selection

```bash
dub create <branch-name> -pm "<commit-message>"
dub ss
```

### Optional: open resulting PR

```bash
dub pr
```

## Error Handling

- **No staged changes**: ask user to stage files or choose `-a/-u/-p` flow.
- **Branch exists already**: suggest alternate name.
- **GitHub auth errors**: prompt `gh auth login`.
- **AI not enabled**: prompt `dub config ai-assistant on` and configure repo defaults if appropriate.
- **Non-interactive terminal**: rerun with `-y` or use `--dry-run` if the user only wants preview output.
- **Submit conflicts/restack issues**: run `dub restack`, resolve conflicts, then rerun `dub ss`.

## Success Output Template

```text
✅ DubStack submission complete
- Branch: <branch-name>
- Commit message: <message>
- Command(s): dub create ..., dub ss
- Next: dub pr (to open PR), dub log (to inspect stack)
```
