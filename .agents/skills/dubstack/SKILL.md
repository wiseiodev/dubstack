---
name: dubstack
description: Use when managing stacked branch workflows with DubStack, including create/modify, navigation, sync/restack, submit, PR opening, and recovery.
---

# DubStack CLI Skill

Use this skill whenever the user is working in a repo that uses `dub` for stacked diffs.

## Core Concepts

- **Stack**: A chain of dependent branches (`main -> feat/a -> feat/b`)
- **Root**: Trunk branch for a stack (commonly `main`)
- **Restack**: Rebase branches so each child is based on its updated parent
- **Submit**: Push stack branches and create/update PRs

## Fast Command Map

| Intent | Command |
|---|---|
| Create branch | `dub create <name>` |
| Create + commit | `dub create <name> -am "msg"` |
| Modify current branch | `dub modify` / `dub m` |
| Navigate stack | `dub up`, `dub down`, `dub top`, `dub bottom` |
| Interactive checkout | `dub checkout` / `dub co` |
| View stack | `dub log` / `dub ls` |
| View current stack only | `dub log --stack` |
| Sync with remote | `dub sync` |
| Check stack health | `dub doctor` |
| Pre-submit checklist | `dub ready` |
| Prune stale tracked metadata | `dub prune [--apply]` |
| Validate merge order | `dub merge-check --pr <number>` |
| Merge next safe PR | `dub merge-next` / `dub land` |
| Post-merge repair | `dub post-merge` |
| Rebase stack | `dub restack` |
| Continue interrupted op | `dub continue` |
| Abort interrupted op | `dub abort` |
| Track/re-parent branch | `dub track [branch] --parent <branch>` |
| Untrack metadata only | `dub untrack [branch] [--downstack]` |
| Stack-aware delete | `dub delete [branch] [--upstack|--downstack]` |
| Show parent/children/trunk | `dub parent`, `dub children`, `dub trunk` |
| Submit PR stack | `dub submit` / `dub ss` |
| Open PR in browser | `dub pr [branch|number]` |
| Undo last create/restack | `dub undo` |

## Command Notes

### Create

```bash
dub create feat/x
dub create feat/x -m "feat: ..."
dub create feat/x -am "feat: ..."
dub create feat/x -um "feat: ..."
dub create feat/x -pm "feat: ..."
```

- `-a`: stage all
- `-u`: stage tracked-file updates
- `-p`: interactive hunk staging
- staging flags require `-m`

### Modify

```bash
dub m
dub m -c -m "fix: ..."
dub m -p
dub m -u
dub m -v
dub m -vv
dub m --interactive-rebase
```

- Restacks descendants after modification.
- `-m` can be passed multiple times.
- `-v` prints staged diff, `-vv` also prints unstaged diff.

### Checkout and Navigation

```bash
dub co
# or
dub checkout --stack
dub checkout --show-untracked
dub checkout --trunk
```

```bash
dub up
dub up 2
dub down
dub down --steps 2
dub top
dub bottom
```

### Sync, Restack, Submit, PR

```bash
dub sync
dub sync --all
dub sync --no-interactive
dub sync --force
dub sync --restack
```

```bash
dub restack
dub restack --continue
dub continue
dub abort
```

```bash
dub ss
dub submit --dry-run
dub submit --path current
dub submit --path stack --fix
dub merge-check --pr 123
dub merge-next
dub post-merge
```

```bash
dub pr
dub pr feat/a
dub pr 123
```

### Track, Untrack, Delete

```bash
dub track
dub track feat/a --parent main

dub untrack feat/a
dub untrack feat/a --downstack

dub delete feat/a
dub delete feat/a --upstack
dub delete feat/a --downstack
dub delete feat/a --force --quiet
```

### Orientation

```bash
dub parent
dub children
dub trunk
```

## Recommended Workflow

1. Start from trunk: `git checkout main && git pull`
2. Create layers with `dub create ... -am ...`
3. Inspect stack with `dub log`
4. Submit with `dub ss`
5. Iterate with `dub m ...` and `dub ss`
6. Keep updated with `dub sync` (add `--restack` when you want automatic post-sync rebasing)

## Recovery Patterns

### Restack conflict

```bash
# after conflict
git add <resolved-files>
dub restack --continue
```

### Undo mistaken create/restack

```bash
dub undo
```

### Branch not tracked

- Track branch explicitly:

```bash
dub track <branch> --parent <parent>
```

- Verify placement:

```bash
dub parent <branch>
dub trunk <branch>
```

## Common Errors

| Symptom | Action |
|---|---|
| `gh CLI not found` | Install `gh` |
| `Not authenticated with GitHub` | `gh auth login` |
| branch missing from stack | Use `dub create` from tracked context |
| sync skips branches | rerun with interactive mode or `--force` if appropriate |

## References

- [Command Reference](./references/commands.md)
- [Workflow Reference](./references/workflows.md)
