# DubStack Command Reference

This is a concise command reference for agents using `dub`.

## Initialization

| Command | Purpose |
|---|---|
| `dub init` | Initialize local DubStack state in current repo |

## Create and Modify

| Command | Purpose |
|---|---|
| `dub create <name>` | Create stacked branch on current branch |
| `dub create <name> -m "msg"` | Create branch and commit staged changes |
| `dub create <name> -am "msg"` | Stage all + create + commit |
| `dub create <name> -um "msg"` | Stage tracked updates + create + commit |
| `dub create <name> -pm "msg"` | Interactive hunk stage + create + commit |
| `dub modify` / `dub m` | Amend current branch commit and restack descendants |
| `dub m -c -m "msg"` | Create a new commit on current branch |
| `dub m -a` | Stage all before modify |
| `dub m -u` | Stage tracked updates before modify |
| `dub m -p` | Interactive hunk staging before modify |
| `dub m -v` / `dub m -vv` | Print staged / staged+unstaged diffs before modify |
| `dub m --interactive-rebase` | Start interactive rebase for current branch commits |

## Visualization and Navigation

| Command | Purpose |
|---|---|
| `dub log` / `dub ls` / `dub l` | Show stack tree |
| `dub checkout` / `dub co` | Interactive checkout |
| `dub checkout <branch>` | Direct checkout |
| `dub checkout --trunk` | Checkout stack trunk |
| `dub checkout --show-untracked` | Include non-tracked local branches in picker |
| `dub checkout --stack` | Restrict picker to current stack |
| `dub up [steps]` | Move upstack by one or more levels |
| `dub down [steps]` | Move downstack by one or more levels |
| `dub top` | Jump to top branch in current stack path |
| `dub bottom` | Jump to first branch above root |
| `dub info [branch]` | Show tracked metadata for branch |
| `dub branch info [branch]` | Equivalent branch metadata command |

## Sync and Rebase

| Command | Purpose |
|---|---|
| `dub sync` | Sync tracked branches with remote and reconcile states |
| `dub sync --all` | Sync all tracked stacks |
| `dub sync --no-interactive` | Deterministic non-interactive mode |
| `dub sync --force` | Skip prompts for destructive actions |
| `dub sync --no-restack` | Skip restack after sync |
| `dub restack` | Rebase branches onto updated parents |
| `dub restack --continue` | Continue after conflict resolution |

## Submit and PR

| Command | Purpose |
|---|---|
| `dub submit` / `dub ss` | Push branches and create/update stack PRs |
| `dub submit --dry-run` | Preview submit actions |
| `dub pr` | Open current branch PR in browser |
| `dub pr <branch-or-number>` | Open specific PR target |

## Recovery

| Command | Purpose |
|---|---|
| `dub undo` | Undo last `create` or `restack` mutation |

## Skills Management

| Command | Purpose |
|---|---|
| `dub skills add [skills...]` | Install packaged skills |
| `dub skills add --dry-run` | Preview skill install |
| `dub skills remove [skills...]` | Remove packaged skills |
| `dub skills remove --dry-run` | Preview skill removal |
