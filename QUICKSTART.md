# DubStack Quick Start

This guide gets you from zero to a working stacked PR flow fast.

## Prerequisites

- `git`
- `gh` CLI authenticated (`gh auth login`)
- `dub` installed (`brew install dubstack` or `npm i -g dubstack`)

## Optional: Enable AI Assistant

```bash
# 1) guided setup for Gemini, AI Gateway, or Amazon Bedrock
dub ai setup

# 2) reload your shell using the command DubStack prints
source ~/.zshrc

# 3) enable assistant for this repo
dub config ai-assistant on

# 4) pin the provider for this repository
dub config ai-provider gemini
# or:
dub config ai-provider gateway
# or:
dub config ai-provider bedrock

# 5) optional: enable AI defaults
dub config ai-defaults create on
dub config ai-defaults submit on
dub config ai-defaults flow on

# 6) ask a question
dub ai ask "Summarize this stack from trunk to current branch"

# optional: inspect recent dub command history/context
dub history --limit 20
```

For Bedrock teams using AWS SSO or role-based auth, the secure non-interactive setup looks like this:

```bash
dub ai env \
  --bedrock-profile "bw-sso" \
  --bedrock-region "us-west-2" \
  --bedrock-model "us.anthropic.claude-sonnet-4-6"

dub config ai-provider bedrock
```

DubStack does not add or manage AWS secret key environment variables for Bedrock.
`dub ai setup` and `dub ai env` print the exact activation command to run after updating your shell profile.

Optional template setup:

```bash
cat <<'EOF' > .gitmessage
feat(scope): summary

## Testing
- [ ] added coverage
EOF

git config commit.template .gitmessage
```

- add a PR template in `.github/pull_request_template.md` or `.github/PULL_REQUEST_TEMPLATE/*.md`
- DubStack AI will follow those templates for generated commit bodies and PR descriptions

## 1) Start from Trunk

```bash
git checkout main
git pull
```

## 2) Create a Stack

Create three stacked branches with commits:

```bash
# Layer 1
dub create feat/auth-types -am "feat: add auth types"

# Layer 2 (parent: feat/auth-types)
dub create feat/auth-login -am "feat: add login flow"

# Layer 3 (parent: feat/auth-login)
dub create feat/auth-tests -am "test: add auth tests"
```

Useful `create` patterns:

```bash
# branch only
dub create feat/new-layer

# use tracked-file-only staging
dub create feat/new-layer -um "feat: ..."

# pick hunks
dub create feat/new-layer -pm "feat: ..."

# AI-generate branch + commit from staged changes
dub create --ai

# override repo AI defaults for one invocation
dub create --no-ai feat/new-layer

# stage all, then AI-generate branch + commit (supports -ai shorthand)
dub create -ai
```

## 3) Inspect and Navigate

```bash
# view stack tree
dub log

# interactive checkout
dub co

# move around current path
dub up
dub down
dub top
dub bottom

# multi-step traversal
dub up 2
dub down --steps 2
```

## 4) Submit Stack PRs

```bash
# submit stack
dub ss

# preview only
dub ss --dry-run

# default scope: current branch + ancestors to trunk
dub ss

# full tree from trunk
dub ss --stack

# upstack: current + all descendants
dub ss --upstack

# single named branch
dub ss --branch feat/api

# AI-generate PR description body
dub submit --ai
```

Open PR in browser:

```bash
dub pr          # current branch PR
dub pr 123      # explicit PR
dub pr feat/x   # explicit branch

# product shortcuts
dub docs        # DubStack docs
dub repo        # current repository GitHub page
```

## 5) Respond to Feedback

When feedback lands on a middle branch:

```bash
dub co feat/auth-login

# amend current commit
dub m -a -m "fix: address review feedback"

# or create a new commit
dub m -c -a -m "fix: follow-up"

# optional: inspect diffs before modifying
dub m -v
dub m -vv

# push updates
dub ss
```

## Optional: Use The AI Flow

```bash
# stage all, preview generated metadata, create, and submit
dub flow --ai -a

# auto-approve after staging tracked files
dub f -y -u
```

If you run `dub flow` in a non-interactive terminal, add `-y` because approval prompts require a TTY.

## 6) Keep Stack in Sync

After trunk changes:

```bash
git checkout main
git pull
dub sync
```

Common sync variants:

```bash
dub sync --all
dub sync --no-interactive
dub sync --force
dub sync --no-restack
```

## 7) Preflight And Cleanup

```bash
dub doctor
dub ready
dub prune         # preview stale tracked branches
dub prune --apply # apply stale metadata cleanup
dub merge-check   # verify stack order and GitHub mergeability
```

## 8) Handle Restack Conflicts

```bash
dub restack
# resolve conflicts in files
git add <resolved-files>
dub restack --continue
```

Unified recovery commands:

```bash
dub continue   # continue active restack/rebase
dub abort      # abort active restack/rebase
```

## 9) Merge In Safe Order

```bash
# optional pre-check (helpful in CI too)
dub merge-check --pr 123

# safest merge flow (bottom-up + maintenance)
# merge-next pre-retargets direct child PRs before deleting merged branches
dub merge-next
dub merge-next
```

History note:

- `main` is configured for linear, squash-style merges.
- For stacks that target intermediate base branches, merge the top stack branch into `main` after lower layers merge so the full stack lands on `main`.

If merges happened manually in GitHub or another UI, the happy path is:

```bash
dub sync
```

`dub post-merge` is still available as an explicit repair command:

```bash
dub post-merge
```

## 10) Repair Tracking Metadata

If you created branches outside `dub create`:

```bash
# track current branch
dub track --parent main

# inspect placement
dub parent
dub children
dub trunk
```

Stop tracking without deleting local git branches:

```bash
dub untrack feat/auth-tests
dub untrack feat/auth-login --downstack
```

Delete branches with stack-aware expansion:

```bash
dub delete feat/auth-login
dub delete feat/auth-login --upstack --force --quiet
```

## 11) Undo Last Stack Mutation

```bash
dub undo
```

`dub undo` supports one level for `create` and `restack` operations.

## Fast Command List

| Command | Purpose |
|---|---|
| `dub create <name> -am "msg"` | Stage all + create + commit |
| `dub m` | Modify current branch commit(s) |
| `dub log` | Show stack graph |
| `dub co` | Interactive checkout |
| `dub ss` | Submit stack PRs |
| `dub pr` | Open PR in browser |
| `dub docs` | Open the DubStack docs site |
| `dub repo` | Open the current repository GitHub page |
| `dub sync` | Sync local state with remote |
| `dub doctor` | Run stack health checks |
| `dub ready` | Run pre-submit checklist |
| `dub prune` | Preview/remove stale tracked metadata |
| `dub merge-check` | Validate stack merge order and GitHub mergeability |
| `dub merge-next` / `dub land` | Merge next safe PR + maintenance |
| `dub post-merge` | Repair state/retarget after manual merges |
| `dub restack` | Rebase stack onto updated parents |
| `dub track` | Track/re-parent branch metadata |
| `dub untrack` | Remove branch metadata only |
| `dub delete` | Stack-aware branch deletion |
| `dub continue` / `dub abort` | Resume/cancel interrupted operations |
| `dub undo` | Undo last create/restack |
| `dub config ai-assistant on` | Enable repo-local AI assistant |
| `dub config ai-provider bedrock` | Pin the repo-local AI provider |
| `dub ai setup` | Guided provider/model/env setup |
| `dub ai ask "..."` | Ask AI assistant (streaming + constrained read-only repo shell tool) |
| `dub flow --ai -a` | Stage, preview, create, and submit with AI |
| `dub history` | Show recent Dub command history |

## Local AI Evals

```bash
pnpm evals
pnpm evals:watch
pnpm evals:export
```

Use these when changing AI-generated flow metadata so branch naming, commit bodies, PR descriptions, and template preservation stay honest.

## Next Step

Read [`README.md`](./README.md) for full command details, sync behavior, and troubleshooting.
