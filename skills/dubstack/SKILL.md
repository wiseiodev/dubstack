---
name: dubstack
description: DubStack CLI reference. Use for managing stacked changes (git branches). Covers creating stacks, navigating, submitting PRs, rebasing (restacking), and undoing mistakes.
---

# DubStack CLI

## Key Concepts

- **Stack**: Chain of dependent branches (e.g., `main` -> `feat/a` -> `feat/b`)
- **Root**: The base branch (usually `main`)
- **Restacking**: Rebasing branches onto their updated parents (e.g., after parent changes)
- **Submit**: Pushing branches and creating/updating GitHub PRs for the entire stack

## Prerequisites

1. **Install**: `npm install -g dubstack` or `brew install wiseiodev/dubstack/dubstack`
2. **Auth**: ensure `gh auth login` is done (DubStack uses `gh` CLI for PRs)
3. **Init**: Auto-initialized on first `dub create` (or run `dub init`)

## Quick Decision Trees

### "I need to start a new feature or stack"
- **Create branch & commit:** `dub create <name> -am "<msg>"`
- **Create branch only:** `dub create <name>` (then git add/commit manually)

### "I need to visualize my work"
- **See stack tree:** `dub log`
- **Switch branches (interactive):** `dub checkout` (or `dub co`)
- **Switch branch directly:** `dub checkout <name>`

### "I need to update code"
- **Modify current branch:** standard git workflow (`git add`, `git commit`)
### "I need to update code"
- **Modify current branch:** standard git workflow (`git add`, `git commit`)
- **Update parent branch:** `dub co <parent>`, modify, commit
- **Propagate parent changes to children:** `dub restack`
- **Propagate parent changes to children:** `dub restack`

### "I need to submit my work"
- **Submit entire stack:** `dub ss` (sets up PRs for all branches in stack)
- **Preview submission:** `dub ss --dry-run`

### "I made a mistake"
- **Undo last DubStack action:** `dub undo` (reverses create/restack)

## Command Reference

| Command | Description |
|---------|-------------|
| `dub create <name> -am "msg"` | Create branch, stage all, commit (like `gt create`) |
| `dub log` | Show ASCII tree of current stack |
| `dub checkout` | Interactive branch picker (alias `dub co`) |
| `dub ss` | Push branches & create/update PRs (alias for `dub submit`) |
| `dub restack` | Rebase all branches in stack onto their parents |
| `dub undo` | Undo last `create` or `restack` operation |
| `dub init` | Manually initialize DubStack (optional) |

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Not authenticated" | Run `gh auth login` |
| "Branch name exists" | Choose different name |
| "Conflict during restack" | Resolve files, `git add`, `git rebase --continue` |
| "Need to sync with main" | `git checkout main && git pull`, then `dub restack` |
| "Accidentally modified wrong branch" | `dub undo` if created via dub, or standard git undo |

## Full Documentation

See `QUICKSTART.md` in the repo root for a complete walkthrough.
