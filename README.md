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

### `dub create <branch>`

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
```

Flags:
- `-m, --message <message>`: commit message
- `-a, --all`: stage all changes before commit (requires `-m`)
- `-u, --update`: stage tracked-file updates before commit (requires `-m`)
- `-p, --patch`: select hunks interactively before commit (requires `-m`)

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

# submit only current linear path (default)
dub submit --path current

# submit the whole stack graph (requires linearity)
dub submit --path stack

# auto-fallback to current path when stack-mode is blocked
dub submit --path stack --fix
```

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

Synchronize tracked branches with remote refs.

```bash
# sync current stack
dub sync

# sync all tracked stacks
dub sync --all

# non-interactive mode
dub sync --no-interactive

# force destructive sync decisions
dub sync --force

# include post-sync restack
dub sync --restack
```

Current sync behavior includes:
- fetch tracked refs from `origin`
- attempt trunk fast-forward (or overwrite with `--force`)
- cleanup for merged/closed PR branches whose commits are confirmed in trunk
- reconcile local/remote divergence states per branch
- optional restack when `--restack` is set

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

Validate merge order for a stack PR.

```bash
# check current branch PR
dub merge-check

# check explicit PR number
dub merge-check --pr 123
```

### `dub merge-next` / `dub land`

Merge the next safe PR in your current stack path, then run post-merge maintenance.

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
| PR merge blocked by order | Run `dub merge-check --pr <number>` and merge previous PR first |
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
