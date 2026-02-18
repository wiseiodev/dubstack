# DubStack Command Reference

## Create & Modify

| Command | Description |
|---------|-------------|
| `dub create <name>` | Create a new branch stacked on the current one |
| `dub create <name> -m "msg"` | Create branch and commit staged changes |
| `dub create <name> -am "msg"` | Stage all changes, create branch, and commit |
| `dub init` | Initialize DubStack state (optional, happens automatically) |

## Visualize & Navigation

| Command | Description |
|---------|-------------|
| `dub log` | Display an ASCII tree of the current stack |
| `dub checkout <name>` | Switch to branch (alias `dub co`) |
| `dub checkout` | Interactive branch ticker/search |

## Submit

| Command | Description |
|---------|-------------|
| `dub ss` | Submit stack (alias for `dub submit`) |
| `dub submit` | Push all branches in stack and create/update PRs |
| `dub submit --dry-run` | Preview what would happen without pushing/creating PRs |

## Sync & Rebase

| Command | Description |
|---------|-------------|
| `dub restack` | Rebase all branches in the stack onto their updated parents |

## Recovery

| Command | Description |
|---------|-------------|
| `dub undo` | Reverse the last `dub create` or `dub restack` operation |
