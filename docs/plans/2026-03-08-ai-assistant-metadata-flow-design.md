# AI Assistant Metadata and Flow Design

## Summary

DubStack already supports AI-assisted branch naming and commit message generation through `dub create --ai`, plus conversational help through `dub ai ask` and conflict resolution through `dub ai resolve`. This design extends AI from an isolated create-time shortcut into a consistent authoring workflow across branch creation, PR submission, and a new end-to-end `dub flow` command.

The design keeps AI optional, explicit, and safe:

- AI remains gated by `dub config ai-assistant on`.
- Per-command flags can force AI on or off.
- Repo-local defaults can enable AI behavior without requiring flags every time.
- PR titles remain commit-derived for squash-merge safety.
- DubStack-owned PR metadata remains deterministic and never AI-authored.

This repo does not use git worktrees, and implementation must avoid git mutations such as `git add`, `git commit`, or `git push` unless the user explicitly requests them.

## Goals

- Add `--ai` and `--no-ai` control to `dub create`.
- Add `--ai` and `--no-ai` control to `dub submit`.
- Add repo-local defaults for AI behavior in create, submit, and flow.
- Add a new `dub flow` command that mirrors the existing `dub-flow` skill as a CLI workflow.
- Expand AI docs into a complete feature overview at `apps/docs/content/docs/guides/ai-assistant.mdx`.
- Update the bundled `skills/dubstack/SKILL.md` guidance so coding agents can configure and use the new AI behaviors.
- Plan a better terminal UI for `dub ai ask`.

## Non-Goals

- AI-generated PR titles.
- Replacing the existing stack table or hidden PR metadata blocks with AI content.
- Silent AI fallback when the user explicitly requested AI.
- Broad changes to non-AI DubStack workflows.

## User Experience

### Master AI Gate

`dub config ai-assistant on|off` remains the master repo-local enablement switch.

- If AI is explicitly requested while the assistant is disabled, the command fails with a clear `DubError`.
- If AI is not explicitly requested, commands resolve behavior through repo defaults.

### Command-Level Precedence

AI mode resolves in this order:

1. Per-invocation flag
2. Repo-local default
3. Built-in default of `off`

This gives users three ways to control behavior:

- `--ai` forces AI on for that command.
- `--no-ai` forces AI off for that command.
- No flag uses the repo-local default.

### `dub create`

`dub create` continues to support manual branch creation and manual commit messages. AI behavior changes to tri-state resolution:

- `dub create --ai`
- `dub create --no-ai`
- `dub create` with repo defaults

When AI is active, DubStack generates:

- branch name
- conventional commit subject

Branch generation still requires staged changes. Existing validation remains:

- branch name must be valid
- commit message must be a conventional commit subject
- staged-change requirements for `-a`, `-u`, and `-p` remain explicit

### `dub submit`

`dub submit --ai` generates a PR description body only.

It does not generate or rewrite the PR title. The title remains the last commit message so squash merges preserve a conventional commit title.

When AI is active, submit generates a human-readable PR summary section using branch context such as:

- branch name
- base branch
- commit message
- branch diff against parent

DubStack then appends its existing deterministic sections:

- stack table
- hidden metadata block

For existing PRs, submit should update only the AI-managed summary section and preserve:

- user-authored freeform content
- DubStack stack table
- DubStack metadata block

### `dub flow`

Add a new high-level command that packages the AI-assisted authoring workflow:

- stage changes
- generate branch name
- generate commit message
- create branch and commit
- submit PRs
- generate PR description

Recommended command forms:

- `dub flow`
- `dub f`

Avoid `dub -f` as a top-level command shortcut. In Commander, single-dash forms behave like options, not subcommands, and would create avoidable parsing ambiguity.

Expected flags:

- `-a, --all`
- `-u, --update`
- `-p, --patch`
- `-y, --yes`
- `--ai`
- `--no-ai`
- `--dry-run`

Default behavior:

- Requires AI to be enabled and available when AI mode resolves to on.
- Shows a preview of generated metadata before mutating anything.
- `-y` auto-approves the generated metadata and skips the confirmation prompt.

Preview content:

- proposed branch name
- proposed commit message
- proposed PR description summary
- exact DubStack commands that will be executed

Previews should render markdown cleanly in the terminal so users can accurately review generated commit and PR content before approval.

## Configuration Design

Keep the existing `aiAssistantEnabled` boolean and extend the config with repo-local defaults:

```json
{
  "aiAssistantEnabled": true,
  "ai": {
    "defaults": {
      "createMetadata": false,
      "submitDescription": false,
      "flow": false
    }
  }
}
```

The `ai.defaults` values apply only when the command invocation does not specify `--ai` or `--no-ai`.

## Internal Architecture

### Shared AI Metadata Layer

AI metadata generation is currently embedded in `packages/cli/src/commands/create.ts`. That logic should move into a shared library so multiple commands can reuse:

- provider resolution
- prompt construction
- JSON parsing
- redaction/truncation
- validation

Recommended new library area:

- `packages/cli/src/lib/ai-metadata.ts`

This helper should expose separate generation functions for:

- create metadata
- PR description summary

### Temporary File Editing and Apply Flow

For editing generated commit messages and PR descriptions, prefer a file-backed flow over inline shell arguments.

Use separate temporary markdown files for:

- commit message content
- PR description content

Recommended sequence:

1. write generated content to temp files
2. open the appropriate file when the user chooses to edit
3. apply the edited content using the relevant `git` or `gh` file-based option
4. delete temp files in cleanup logic even on failure

Examples:

- commit message application should prefer a file-backed git flow such as `git commit --file <path>`
- PR description application should prefer `gh pr create --body-file <path>` or `gh pr edit --body-file <path>`

This avoids brittle multiline shell escaping and gives users a reliable editing path.

### PR Body Composition

`packages/cli/src/lib/pr-body.ts` currently preserves user content while appending the DubStack stack table and metadata block. To support AI summaries safely, PR body composition should gain explicit markers for an AI-managed summary section.

Suggested shape:

- AI summary marker start/end
- helper to strip and replace only that section
- final composition order:
  1. preserved user content
  2. AI summary section
  3. DubStack stack table
  4. hidden metadata block

This keeps deterministic DubStack sections isolated from generated text.

### Config Command Surface

Keep `dub config ai-assistant` as the master toggle and add focused configuration for defaults, for example:

- `dub config ai-defaults create on|off`
- `dub config ai-defaults submit on|off`
- `dub config ai-defaults flow on|off`

This is clearer than overloading `ai-assistant` with multiple meanings.

## Documentation Changes

Expand `apps/docs/content/docs/guides/ai-assistant.mdx` into the canonical AI overview page. It should intentionally duplicate key information from command reference pages.

Sections to add:

- setup and provider selection
- AI shortcut entry points
  - `dub "prompt"`
  - `dub --ai "prompt"`
  - `dub ai ask`
- AI-assisted create
  - `dub create --ai`
  - `dub create --no-ai`
- AI-assisted submit
  - `dub submit --ai`
  - `dub submit --no-ai`
- end-to-end AI workflow
  - `dub flow`
  - `dub f`
- AI conflict resolution
  - `dub ai resolve`
  - `dub continue --ai`
- repo-local defaults and precedence
- safety guarantees and limitations

Related docs that should be updated for consistency:

- command reference pages for `create` and `submit`
- docs homepage and quickstart snippets that mention AI behavior
- any other docs pages that mention AI commands, AI flags, or AI capabilities so the site stays internally consistent

This should be treated as a docs-site audit, not a single-page update. Any page that mentions:

- `dub ai ask`
- `dub ai env`
- `dub config ai-assistant`
- `dub create --ai`
- `dub submit --ai`
- `--no-ai`
- AI conflict resolution
- `dub flow`

should be reviewed and updated as needed.

## Skill Updates

Update `skills/dubstack/SKILL.md` so bundled coding agents know how to:

- configure AI keys with `dub ai env`
- enable AI in a repo with `dub config ai-assistant on`
- use `dub create --ai`, `dub submit --ai`, and `--no-ai`
- use repo-local AI defaults
- use `dub flow` / `dub f`
- understand that PR titles stay commit-derived
- understand that PR descriptions are AI-generated but DubStack metadata remains deterministic
- find AI conflict-resolution commands

The recommended workflow section should include both:

- manual workflow
- AI-assisted workflow

## Terminal UI Improvement Plan

The current `dub ai ask` renderer is too raw for human use. Today it mostly streams plain text plus a carriage-return spinner preview. A phased improvement plan is appropriate.

### Phase 1: Better Live Status and Markdown Preview

- replace the current noisy thinking preview with concise status labels
- show tool activity explicitly
- introduce readable terminal markdown rendering for streamed AI responses and generated-content previews
- keep non-TTY output plain and stable

### Phase 2: Rich Response Rendering and Approval UX

- render headings, bullets, code fences, blockquotes, and tables more clearly
- improve spacing and section separation
- add light formatting with `chalk`
- use rendered markdown for approval screens that preview generated commit messages and PR descriptions

### Phase 3: Shared Rich Preview UI

- reuse terminal cards/previews for `dub create --ai`, `dub submit --ai`, and `dub flow`
- show approval screens with clean labels and clear next actions

## Risks and Mitigations

### Risk: AI body updates overwrite user-written PR content

Mitigation:

- use explicit AI summary markers
- preserve non-marked user content
- preserve DubStack-owned sections separately

### Risk: Too many overlapping AI toggles become confusing

Mitigation:

- keep a simple precedence model
- use `--no-ai` consistently
- document examples in the AI guide and the bundled skill

### Risk: `dub flow` duplicates existing commands without adding clarity

Mitigation:

- make it a thin orchestrator around `create` and `submit`
- keep lower-level commands unchanged and documented
- position it as the fastest path, not the only path

## Rollout Order

1. Config defaults and shared AI metadata helpers
2. `dub create` tri-state AI behavior
3. `dub submit` AI-generated PR description summaries
4. `dub flow` and `dub f`
5. Documentation and skill updates
6. Terminal UI improvements for `dub ai ask`
