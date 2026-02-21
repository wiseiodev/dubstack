# DubStack Quick Start

This guide gets you from zero to a working stacked PR flow fast.

## Prerequisites

- `git`
- `gh` CLI authenticated (`gh auth login`)
- `dub` installed (`brew install dubstack` or `npm i -g dubstack`)

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
dub sync --no-restack
```

## 7) Handle Restack Conflicts

```bash
dub restack
# resolve conflicts in files
git add <resolved-files>
dub restack --continue
```

## 8) Undo Last Stack Mutation

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
| `dub restack` | Rebase stack onto updated parents |
| `dub undo` | Undo last create/restack |

## Next Step

Read [`README.md`](./README.md) for full command details, sync behavior, and troubleshooting.
