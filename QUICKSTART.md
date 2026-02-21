# DubStack Quick Start

This guide gets you from zero to a working stacked PR flow fast.

## Prerequisites

- `git`
- `gh` CLI authenticated (`gh auth login`)
- `dub` installed (`brew install dubstack` or `npm i -g dubstack`)

## Optional: Enable AI Assistant

```bash
# 1) add one API key to your shell profile
dub ai env --gemini-key "<your-gemini-key>"
# or:
dub ai env --gateway-key "<your-ai-gateway-key>"

# 2) reload your shell
source ~/.zshrc

# 3) enable assistant for this repo
dub config ai-assistant on

# 4) ask a question
dub ai ask "Summarize this stack from trunk to current branch"

# optional: inspect recent dub command history/context
dub history --limit 20
```

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

# current-path submit (default behavior)
dub ss --path current
```

Open PR in browser:

```bash
dub pr          # current branch PR
dub pr 123      # explicit PR
dub pr feat/x   # explicit branch
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
dub sync --restack
```

## 7) Preflight And Cleanup

```bash
dub doctor
dub ready
dub prune         # preview stale tracked branches
dub prune --apply # apply stale metadata cleanup
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

If merges happened manually:

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
| `dub sync` | Sync local state with remote |
| `dub doctor` | Run stack health checks |
| `dub ready` | Run pre-submit checklist |
| `dub prune` | Preview/remove stale tracked metadata |
| `dub merge-check` | Validate stack merge order |
| `dub merge-next` / `dub land` | Merge next safe PR + maintenance |
| `dub post-merge` | Repair state/retarget after manual merges |
| `dub restack` | Rebase stack onto updated parents |
| `dub track` | Track/re-parent branch metadata |
| `dub untrack` | Remove branch metadata only |
| `dub delete` | Stack-aware branch deletion |
| `dub continue` / `dub abort` | Resume/cancel interrupted operations |
| `dub undo` | Undo last create/restack |
| `dub config ai-assistant on` | Enable repo-local AI assistant |
| `dub ai ask "..."` | Ask AI assistant (streaming + repo bash tool) |
| `dub history` | Show recent Dub command history |

## Next Step

Read [`README.md`](./README.md) for full command details, sync behavior, and troubleshooting.
