# DubStack

DubStack (`dub`) is a local-first CLI for stacked branch workflows.

It is designed for the Graphite mental model: small, dependent PRs that are easy to review, update, and rebase.

## Why DubStack

Large PRs are hard to review and painful to keep up to date.

Stacked branches let you split work into focused layers:

```text
(main)
  └─ feat/auth-types
       └─ feat/auth-login
            └─ feat/auth-tests
```

When a lower branch changes, `dub restack` propagates it upstack.

## Install

### Homebrew (recommended)

```bash
brew tap wiseiodev/dubstack
brew install dubstack
```

Update:

```bash
brew upgrade dubstack
```

### npm

```bash
npm install -g dubstack
```

### From source

```bash
git clone https://github.com/wiseiodev/dubstack.git
cd dubstack
pnpm install
pnpm build
pnpm link --global
```

## Graphite Mental Model

If you have `gt` muscle memory, use this as a fast map:

| Graphite (`gt`) | DubStack (`dub`) |
|---|---|
| `gt create` | `dub create` |
| `gt modify` | `dub modify` or `dub m` |
| `gt submit` / `gt ss` | `dub submit` / `dub ss` |
| `gt sync` | `dub sync` |
| `gt checkout` / `gt co` | `dub checkout` / `dub co` |
| `gt log` / `gt ls` | `dub log` / `dub ls` |
| `gt up` / `gt down` | `dub up` / `dub down` |
| `gt top` / `gt bottom` | `dub top` / `dub bottom` |
| `gt info` | `dub info` |
| `gt pr` | `dub pr` |
| `gt restack` | `dub restack` |
| `gt continue` | `dub continue` |
| `gt abort` | `dub abort` |
| `gt track --parent` | `dub track --parent` |
| `gt untrack` | `dub untrack` |
| `gt delete` | `dub delete` |
| `gt parent` | `dub parent` |
| `gt children` | `dub children` |
| `gt trunk` | `dub trunk` |
| `gt undo` | `dub undo` |

## Quick Start

```bash
# 1) Start from trunk
git checkout main
git pull

# 2) Create stacked branches
# Create + stage all + commit
dub create feat/auth-types -am "feat: add auth types"
dub create feat/auth-login -am "feat: add login flow"
dub create feat/auth-tests -am "test: add auth tests"

# 3) View stack
dub log

# 4) Submit stack PRs
dub ss

# 5) Open PR for current branch
dub pr

# 6) Open docs or the current repository homepage
dub docs
dub repo
```

For a more detailed walkthrough, see [`QUICKSTART.md`](./QUICKSTART.md).

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for contributor workflow, coding-agent guidance, commit conventions, and PR expectations.

## Command Reference

### `dub init`

Initialize DubStack state in the current git repository.

```bash
dub init
```

Notes:
- `dub create` auto-initializes state if needed.
- Running `dub init` manually is still useful for explicit setup.

### `dub docs`

Open the DubStack docs site in your browser.

```bash
dub docs
```

### `dub repo`

Open the current repository GitHub page in your browser.

```bash
dub repo
```

### `dub create [branch]`

Create a branch stacked on top of the current branch.

```bash
# branch only
dub create feat/my-change

# create + commit staged changes
dub create feat/my-change -m "feat: ..."

# stage all + create + commit
dub create feat/my-change -am "feat: ..."

# stage tracked-file updates + create + commit
dub create feat/my-change -um "feat: ..."

# interactive hunk staging + create + commit
dub create feat/my-change -pm "feat: ..."

# AI-generate branch + conventional commit from staged changes
dub create --ai

# override repo AI defaults for one invocation
dub create --no-ai feat/my-change

# stage all, then AI-generate branch + commit (supports -ai shorthand)
dub create -ai
```

Flags:
- `-m, --message <message>`: commit message
- `-a, --all`: stage all changes before commit (requires `-m` or `--ai`)
- `-u, --update`: stage tracked-file updates before commit (requires `-m` or `--ai`)
- `-p, --patch`: select hunks interactively before commit (requires `-m` or `--ai`)
- `-i, --ai`: AI-generate branch + conventional commit from staged changes
- `--no-ai`: disable AI generation for this invocation

If the repo configures `git config commit.template`, DubStack includes that template when generating AI commit messages so the body follows the repo's expected structure.

### `dub modify` / `dub m`

Amend or create commits on the current branch, then restack descendants.

```bash
# amend current commit
dub modify

# create a new commit
dub modify -c -m "fix: ..."

# interactive staging
dub modify -p

# stage all tracked updates
dub modify -u

# show staged diff before modify
dub modify -v

# show staged + unstaged diff before modify
dub modify -vv

# interactive rebase of this branch's commits
dub modify --interactive-rebase
```

Flags:
- `-a, --all`
- `-u, --update`
- `-p, --patch`
- `-c, --commit`
- `-e, --edit`
- `-m, --message <message>` (repeatable)
- `-v, --verbose` (repeatable)
- `--interactive-rebase`

### `dub checkout` / `dub co`

Checkout a branch directly or use interactive search.

```bash
# checkout explicit branch
dub checkout feat/auth-login

# interactive picker
dub checkout

# checkout trunk for current tracked stack
dub checkout --trunk

# interactive picker including non-tracked local branches
dub checkout --show-untracked

# interactive picker scoped to current stack
dub checkout --stack
```

### `dub log` / `dub ls` / `dub l`

Render tracked stacks as an ASCII tree.

```bash
dub log
dub ls
dub l

# show only current stack
dub log --stack

# show all stacks explicitly
dub log --all

# reverse branch ordering for quick top-down scan
dub log --reverse
```

### Navigation: `dub up`, `dub down`, `dub top`, `dub bottom`

```bash
# move one branch upstack
dub up

# move multiple levels upstack
dub up 2
# or: dub up --steps 2

# move downstack
dub down
dub down 2

# jump to tip branch in current path
dub top

# jump to first branch above root
dub bottom
```

### `dub info` and `dub branch info`

Show tracked metadata for a branch.

```bash
# current branch
dub info

# explicit branch
dub info feat/auth-login

# equivalent legacy style
dub branch info
```

### Orientation: `dub parent`, `dub children`, `dub trunk`

Quickly inspect where the current branch sits in its tracked stack.

```bash
dub parent     # direct parent of current branch
dub children   # direct children
dub trunk      # stack root/trunk branch
```

All three commands accept an optional branch argument:

```bash
dub parent feat/auth-login
dub children feat/auth-types
dub trunk feat/auth-tests
```

If branch metadata is missing, these commands print a remediation path using `dub track`.

### `dub track [branch] [--parent <branch>]`

Track an existing local branch or re-parent a tracked branch.

```bash
# track current branch
dub track

# track explicit branch
dub track feat/auth-login --parent feat/auth-types

# repair parent metadata
dub track feat/auth-login --parent main
```

Notes:
- If `--parent` is omitted, DubStack tries to infer a safe default.
- In interactive shells, DubStack prompts when parent choice is ambiguous.
- Re-parenting can require follow-up rebasing via `dub restack`.

### `dub untrack [branch] [--downstack]`

Remove branch metadata from DubStack without deleting local git branches.

```bash
# untrack current branch only
dub untrack

# untrack explicit branch and descendants
dub untrack feat/auth-login --downstack
```

Use this when branch exists locally but should no longer participate in stack operations.

### `dub delete [branch] [--upstack|--downstack] [--force] [--quiet]`

Delete local branches with stack-aware expansion and metadata repair.

```bash
# delete one branch (with confirmation)
dub delete feat/auth-login

# delete branch and descendants
dub delete feat/auth-login --upstack

# delete branch and ancestors toward trunk
dub delete feat/auth-login --downstack

# fully non-interactive destructive delete
dub delete feat/auth-login --upstack --force --quiet
```

Flags:
- `--upstack`: include descendants
- `--downstack`: include ancestors (excluding root)
- `-f, --force`: force delete unmerged branches
- `-q, --quiet`: skip confirmation prompt

### `dub continue` / `dub abort`

Unified recovery pair for interrupted restacks and rebases.

```bash
# continue active restack/rebase
dub continue

# abort active restack/rebase
dub abort
```

Use these when the CLI reports conflicts or an in-progress operation.

### `dub submit` / `dub ss`

Push branches and create or update PRs.

```bash
dub submit
dub ss

# preview only
dub submit --dry-run

# AI-generate PR description body
dub submit --ai

# submit only current linear path (default)
dub submit --path current

# submit the whole stack graph (requires linearity)
dub submit --path stack

# auto-fallback to current path when stack-mode is blocked
dub submit --path stack --fix
```

Notes:
- `--no-ai` disables AI PR description generation for one invocation.
- AI submit only writes the PR description body; the PR title still comes from the last commit message.
- If the repo has a PR template in a supported GitHub template location, DubStack preserves that structure when generating AI PR descriptions.

### `dub flow` / `dub f`

Stage, preview, create, and submit an AI-assisted change.

```bash
# stage all, preview, create, commit, and submit
dub flow --ai -a

# auto-approve after staging tracked files
dub flow -y -u

# preview only
dub f --dry-run
```

`dub flow` requires an interactive terminal for approval. In non-interactive environments, pass `-y` to auto-approve after the preview is rendered.

Flags:
- `-a, --all`
- `-u, --update`
- `-p, --patch`
- `-y, --yes`
- `-i, --ai`
- `--no-ai`
- `--dry-run`

### `dub pr [branch-or-number]`

Open a PR in browser via `gh`.

```bash
# current branch PR
dub pr

# explicit branch / PR target
dub pr feat/auth-login
dub pr 123
```

### `dub sync`

Synchronize tracked branches with remote refs and repair stack state after
manual merges.

```bash
# sync current stack
dub sync

# sync all tracked stacks
dub sync --all

# non-interactive mode
dub sync --no-interactive

# force destructive sync decisions
dub sync --force

# keep sync conservative if you need to skip rebases
dub sync --no-restack
```

Current sync behavior includes:
- fetch tracked refs from `origin`
- attempt trunk fast-forward (or overwrite with `--force`)
- auto-clean local branches for merged PRs (and closed PRs confirmed in trunk)
- retarget surviving child PRs after merged-parent cleanup
- refresh affected branch PRs after post-merge maintenance
- reconcile local/remote divergence states per branch
- restack by default unless `--no-restack` is set

Recommended post-merge flow:

```bash
# merged in GitHub or another UI
dub sync
```

If sync hits a real conflict, prefer:

```bash
dub continue --ai
```

### `dub doctor`

Run health checks for stack metadata and submit readiness.

```bash
dub doctor

# check all stacks
dub doctor --all

# skip remote fetch if needed
dub doctor --no-fetch
```

Checks include:
- in-progress operation detection (`dub continue`/`dub abort`)
- missing tracked local/remote branches
- submit branching blockers
- local/remote SHA drift
- structural parent/child ancestry drift that can leave GitHub conflicted while local refs look clean
- remote GitHub base drift, where the remote PR head is no longer descended from the base branch GitHub is actually evaluating

If `dub doctor` reports a GitHub base mismatch, refresh that base first, then replay and resubmit:

```bash
git checkout main && git pull --ff-only origin main
dub restack
dub submit --path current
```

### `dub ready`

Run pre-submit checklist (`doctor` + submit preflight).

```bash
dub ready
```

### `dub prune`

Preview or remove stale tracked branch metadata.

```bash
# preview only
dub prune

# apply removals
dub prune --apply

# include every stack
dub prune --all --apply
```

### `dub merge-check`

Validate merge order and GitHub mergeability for a stack PR.

```bash
# check current branch PR
dub merge-check

# check explicit PR number
dub merge-check --pr 123
```

### `dub merge-next` / `dub land`

Merge the next safe PR in your current stack path, pre-retarget direct child PRs
to the parent base, then run post-merge maintenance.

```bash
dub merge-next
# alias
dub land

# preview only
dub merge-next --dry-run
```

### `dub post-merge`

Repair stack metadata and retarget remaining PRs after manual merges.

```bash
dub post-merge

# preview only
dub post-merge --dry-run

# include all stacks
dub post-merge --all
```

### `dub restack`

Rebase stack branches onto updated parents.

```bash
dub restack

# continue after resolving conflicts
dub restack --continue
```

### `dub undo`

Undo last `dub create` or `dub restack` operation.

```bash
dub undo
```

### `dub skills`

Install or remove packaged agent skills.

```bash
# install all bundled skills
dub skills add

# install one skill
dub skills add dubstack

# remove one skill
dub skills remove dub-flow

# preview without changing anything
dub skills add --dry-run
dub skills remove --dry-run
```

### `dub config ai-assistant [on|off]`

Enable or disable the repo-local AI assistant flag.

```bash
# check current value
dub config ai-assistant

# enable for this repository
dub config ai-assistant on

# disable for this repository
dub config ai-assistant off
```

### `dub config ai-defaults <create|submit|flow> [on|off]`

Manage repo-local defaults for AI-assisted authoring.

```bash
# inspect current value
dub config ai-defaults create

# enable AI by default
dub config ai-defaults create on
dub config ai-defaults submit on
dub config ai-defaults flow on
```

### `dub config ai-provider [auto|gemini|gateway|bedrock]`

Manage the repo-local AI provider selection.

```bash
# inspect current provider
dub config ai-provider

# pin this repository to Bedrock
dub config ai-provider bedrock

# return to backward-compatible auto selection
dub config ai-provider auto
```

### `dub config ai-model [model] --provider <provider>`

Manage repo-local model overrides by provider.

```bash
# inspect current Bedrock override
dub config ai-model --provider bedrock

# set a repo-local override
dub config ai-model "us.anthropic.claude-sonnet-4-6" --provider bedrock

# clear the repo-local override
dub config ai-model --provider bedrock --clear
```

### `dub ai ask <prompt...>`

Ask DubStack's AI assistant using streaming output (`streamText`).

```bash
dub ai ask "Summarize what this stack is changing"
```

`dub ai ask` automatically includes a context packet (current branch/stack signals, git status, doctor summary, and recent Dub command history) so it can give better recovery guidance.
In TTY mode, response text streams live while status/tool activity lines are rendered separately for readability.

To inspect your repository, `dub ai ask` can invoke a constrained shell tool limited to a strict allow-list of safe, read-only commands (for example `git status`, `dub doctor`, `dub ready`) when command output is needed.
The assistant cannot execute arbitrary shell commands; requests outside this allow-list are rejected, and additional safety checks block destructive command patterns.

Provider/model selection:
- Repo config from `dub config ai-provider ...` wins when set to `gemini`, `gateway`, or `bedrock`.
- Repo-local model overrides from `dub config ai-model ...` win for that provider when present.
- In `auto` mode, DubStack preserves the legacy fallback order: Gemini, then AI Gateway, then Bedrock.
- Gemini uses `DUBSTACK_GEMINI_API_KEY` with optional `DUBSTACK_GEMINI_MODEL` override.
- AI Gateway uses `DUBSTACK_AI_GATEWAY_API_KEY` with optional `DUBSTACK_AI_GATEWAY_MODEL` override.
- Bedrock uses `DUBSTACK_BEDROCK_AWS_REGION`, `DUBSTACK_BEDROCK_MODEL`, and optional `DUBSTACK_BEDROCK_AWS_PROFILE`.
- Bedrock support uses AWS credential-chain auth only. DubStack does not manage AWS secret key environment variables.

Thinking is enabled by default for Gemini 3 Flash.

Template support:
- PR templates: `.github/pull_request_template.md`, `.github/PULL_REQUEST_TEMPLATE.md`, `.github/PULL_REQUEST_TEMPLATE/*.md`, `docs/pull_request_template.md`, `pull_request_template.md`
- commit templates: configured with `git config commit.template <path>`

When templates are present, DubStack uses them as the formatting contract for AI-generated commit messages and PR descriptions.

## AI Evals

DubStack uses [Evalite](https://v1.evalite.dev/getting-started) for local AI quality checks around generated metadata.

```bash
# run the curated dub flow metadata suite
pnpm evals

# rerun on file changes while iterating on prompts/scorers
pnpm evals:watch

# export the latest local report
pnpm evals:export
```

The first suite lives at `packages/cli/evals/dub-flow-metadata.eval.ts` and evaluates the pure `generateFlowMetadata(...)` helper used by `dub flow`.
It mixes deterministic contract checks with an AI judge scorer so prompt changes are measured against staged diff fidelity, template preservation, and reviewer usefulness.

### `dub ai setup`

Run the guided setup flow for Gemini, AI Gateway, or Amazon Bedrock.

```bash
dub ai setup
```

The setup wizard helps you:
- choose the repo-local provider
- choose a curated model or enter a custom model ID
- write global provider defaults into your shell profile
- optionally store a repo-local model override

When the wizard writes env vars, DubStack loads them into the current `dub` process and prints the exact command to run in your shell to activate them immediately.

### `dub ai env`

Write DubStack AI provider settings into your shell profile (macOS/Linux shells).

```bash
# write Gemini key
dub ai env --gemini-key "<your-key>"

# write Gateway key
dub ai env --gateway-key "<your-key>"

# write Gemini model override
dub ai env --gemini-model "gemini-2.5-pro-preview"

# write Gateway model override
dub ai env --gateway-model "google/gemini-2.5-pro"

# write Bedrock profile + region + model
dub ai env \
  --bedrock-profile "bw-sso" \
  --bedrock-region "us-west-2" \
  --bedrock-model "us.anthropic.claude-sonnet-4-6"

# write both
dub ai env --gemini-key "<gemini-key>" --gateway-key "<gateway-key>"

# write key + model together
dub ai env --gemini-key "<gemini-key>" --gemini-model "gemini-3-flash-preview"

# target a specific profile file explicitly
dub ai env --gemini-key "<your-key>" --profile ~/.zshrc
```

Supported automatic profile detection:
- `zsh` → `~/.zshrc`
- `bash` → `~/.bashrc` (or `~/.bash_profile` fallback)

After writing exports, DubStack prints the exact activation command to run in your shell so the new values take effect immediately in your terminal session.

### `dub history`

Inspect recent Dub command history used for troubleshooting context.

```bash
# show last 20 entries
dub history

# show more
dub history --limit 50

# machine-readable output
dub history --json
```

## Typical Workflows

### Add review feedback to a middle branch

```bash
# jump to branch needing edits
dub co feat/auth-login

# edit + amend + restack descendants
dub m -a -m "fix: address feedback"

# resubmit stack
dub ss
```

### Sync after trunk moves

```bash
git checkout main
git pull
dub sync
# optional restack in one command
dub sync --restack
```

### Merge stacks safely (bottom-up)

```bash
# merge next safe PR in stack order
dub merge-next

# run again for the next layer
dub merge-next
```

If you merged manually, normalize state and retarget remaining PRs:

```bash
dub post-merge
```

### Recover from restack conflict

```bash
dub restack
# resolve conflicts
git add <resolved-files>
dub restack --continue
```

## Troubleshooting

| Problem | What to do |
|---|---|
| `gh CLI not found` | Install GitHub CLI: https://cli.github.com |
| `Not authenticated with GitHub` | Run `gh auth login` |
| Branch not part of stack | Create via `dub create` or run from tracked branch |
| Restack conflict | Resolve files, `git add`, `dub restack --continue` |
| Rebase/restack interrupted | Use `dub continue` to resume, `dub abort` to cancel |
| Branch not tracked | Run `dub track <branch> --parent <parent>` |
| Need metadata-only removal | Use `dub untrack` (or `--downstack`) |
| Need stack-aware branch deletion | Use `dub delete` with `--upstack` / `--downstack` |
| Sync skipped branch | Re-run with `--interactive` or `--force` as appropriate |
| Wrong operation during create/restack | Use `dub undo` (single-level) |
| PR merge blocked by order or GitHub conflict | Run `dub merge-check --pr <number>` to verify stack order and remote mergeability |
| Manual merge left stack inconsistent | Run `dub post-merge` |

### Stale Branch Recovery

When submit or sync gets blocked by stale tracked branches:

```bash
# 1) Inspect current health
dub doctor

# 2) Preview stale branch metadata
dub prune

# 3) Remove stale metadata if confirmed
dub prune --apply

# 4) Re-run pre-submit checks
dub ready

# 5) Submit current linear path
dub submit --path current
```

## State Files

DubStack stores local state in your repo:

```text
.git/dubstack/
├── state.json
├── undo.json
└── restack-progress.json
```

Nothing is pushed to your remote from these files.

## Development

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm checks
pnpm checks:fix
pnpm build
```

## License

MIT
