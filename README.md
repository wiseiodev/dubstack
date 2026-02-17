# DubStack

A local-first CLI for managing **stacked diffs** — chains of dependent git branches that build on each other. Stop juggling complex rebase chains by hand.

## Why Stacked Diffs?

Stacked diffs let you break large features into small, reviewable PRs that depend on each other. Instead of one 2,000-line monster PR, you get a clean chain:

```
(main)
  └─ feat/api-models
       └─ feat/api-endpoint
            └─ feat/ui-component
```

When `main` updates or you amend an earlier branch, `dub restack` cascades rebases through the entire chain for you.

## Install

> Requires **Node ≥ 22** and **pnpm**.

```bash
# Clone and install
git clone <repo-url> && cd dubstack
pnpm install

# Link globally so `dub` is available everywhere
pnpm build
pnpm link --global
```

## Quick Start

```bash
# 1. Initialize in any git repo
cd my-project
dub init

# 2. Start stacking branches
git checkout main
dub create feat/api-models
# hack hack hack, commit...

dub create feat/api-endpoint
# hack hack hack, commit...

dub create feat/ui-component
# hack hack hack, commit...

# 3. See your stack
dub log

# 4. Rebase the whole chain after main updates
git checkout main && git pull
dub restack

# 5. Made a mistake? Undo it
dub undo
```

## Commands

### `dub init`

Initializes DubStack in the current git repository.

```bash
dub init
```

- Creates `.git/dubstack/state.json` with an empty state
- Adds `.git/dubstack` to `.gitignore`
- **Idempotent** — safe to run multiple times

```
✔ DubStack initialized            # first run
⚠ DubStack already initialized    # subsequent runs
```

---

### `dub create <branch-name>`

Creates a new branch stacked on top of the current branch.

```bash
# On main
dub create feat/api-models

# On feat/api-models
dub create feat/api-endpoint
```

- Checks out the new branch at the current HEAD
- Records the parent → child relationship in state
- Auto-creates a new stack if the parent isn't already tracked
- Saves an undo snapshot before any mutation

**Errors:**
| Condition | Message |
|---|---|
| Not initialized | `DubStack is not initialized. Run 'dub init' first.` |
| Branch already exists | `Branch '<name>' already exists.` |
| Detached HEAD | `HEAD is detached. Check out a branch first.` |

---

### `dub log`

Displays an ASCII tree of all tracked stacks.

```bash
dub log
```

Example output:

```
(main)
  ├─ feat/api-models
  │    └─ feat/api-endpoint (Current)
  └─ feat/auth
       └─ feat/auth-ui ⚠ (missing)
```

- **Current branch** is highlighted and marked `(Current)`
- **Root branches** are shown in parentheses, e.g. `(main)`
- **Deleted branches** still tracked in state show `⚠ (missing)`
- Multiple stacks are separated by blank lines

---

### `dub restack`

Rebases all branches in the current stack onto their updated parents.

```bash
dub restack
```

**How it works:**

1. Snapshots every branch tip _before_ starting
2. Walks the tree in topological order (parents first)
3. For each child branch, runs `git rebase --onto <parent_new_tip> <parent_old_tip> <child>`
4. Skips branches whose parent hasn't moved
5. Returns you to the branch you started on

**Conflict handling:**

If a rebase hits a conflict, DubStack pauses and tells you:

```
⚠ Conflict while restacking 'feat/api-endpoint'
  Resolve conflicts, stage changes, then run: dub restack --continue
```

After resolving:

```bash
# Fix the conflicting files
git add .
dub restack --continue
```

Progress is saved to `.git/dubstack/restack-progress.json`, so the resume picks up exactly where it left off.

**Output examples:**

```
✔ Stack is already up to date

✔ Restacked 2 branch(es)
  ↳ feat/api-models
  ↳ feat/api-endpoint
```

**Errors:**
| Condition | Message |
|---|---|
| Uncommitted changes | `Working tree has uncommitted changes. Commit or stash them before restacking.` |
| Branch not in a stack | `Branch '<name>' is not part of any stack.` |
| Tracked branch deleted | `Branch '<name>' is tracked in state but no longer exists in git.` |

---

### `dub undo`

Rolls back the last `dub create` or `dub restack` operation.

```bash
dub undo
```

**Undo strategies:**

- **After `create`:** Deletes the created branch, restores state, checks out the previous branch
- **After `restack`:** Force-resets every rebased branch to its pre-rebase commit, restores state

Only **one level** of undo is supported. After undo, the undo entry is cleared.

```
✔ Undid 'create': Deleted branch 'feat/api-endpoint'
✔ Undid 'restack': Reset 3 branches to pre-restack state
```

**Errors:**
| Condition | Message |
|---|---|
| Nothing to undo | `Nothing to undo.` |
| Uncommitted changes | `Working tree has uncommitted changes. Commit or stash them before undoing.` |

---

## Typical Workflow

```bash
# Start a feature stack off main
git checkout main
dub create feat/data-layer
# write code, commit

dub create feat/api-routes
# write code, commit

dub create feat/frontend
# write code, commit

# View the stack
dub log
# (main)
#   └─ feat/data-layer
#        └─ feat/api-routes
#             └─ feat/frontend (Current)

# Later: main gets updated, or you amend feat/data-layer
git checkout feat/data-layer
# amend your commits...
dub restack
# ✔ Restacked 2 branch(es)
#   ↳ feat/api-routes
#   ↳ feat/frontend

# Oops, that restack went wrong
dub undo
# ✔ Undid 'restack': Reset 3 branches to pre-restack state
```

## How State Works

DubStack stores all state locally inside your git repo:

```
.git/dubstack/
├── state.json               # branch relationships and stack metadata
├── undo.json                 # snapshot for single-level undo
└── restack-progress.json     # in-flight restack state (temporary)
```

Nothing is pushed to your remote. State is per-repo and git-ignored.

## Development

```bash
pnpm install          # install deps
pnpm dev              # run via tsx (no build step)
pnpm build            # compile TypeScript to dist/
pnpm test             # run tests (vitest)
pnpm typecheck        # type-check without emitting
pnpm checks           # lint + format check (biome)
pnpm checks:fix       # auto-fix lint + format issues
```

## License

MIT
