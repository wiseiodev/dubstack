# DubStack Workflow Reference

Use these as copy-paste playbooks.

## 1) Create and Submit a New Stack

```bash
git checkout main
git pull

dub create feat/base -am "feat: add base layer"
dub create feat/middle -am "feat: add middle layer"
dub create feat/top -am "feat: add top layer"

dub log
dub ss
```

## 2) Update a Middle Branch After Review

```bash
dub co feat/middle

# edit files...
dub m -a -m "fix: address review feedback"

# optional diff check before modify
dub m -vv

dub ss
```

## 3) Sync After Trunk Moves

```bash
git checkout main
git pull

dub sync
dub doctor
dub ready
```

If you need deterministic non-interactive behavior:

```bash
dub sync --no-interactive
```

If you want automatic restack after sync:

```bash
dub sync
```

If you need to skip rebases for one run:

```bash
dub sync --no-restack
```

If you explicitly want destructive reconciliation:

```bash
dub sync --force
```

## 4) Clean Stale Tracked Metadata

```bash
# preview
dub prune

# apply
dub prune --apply
```

## 5) Merge Stack Safely (Bottom-Up)

```bash
# optional explicit guard
dub merge-check --pr 123

# merge next safe PR + run maintenance
# uses GitHub merge queue automatically when trunk requires it
dub merge-next

# repeat until complete
dub merge-next
```

When queue mode is used, run `dub sync` after GitHub processes the queue.

If manual merges happened in GitHub or another UI:

```bash
dub sync
```

`dub post-merge` remains available when you want the explicit repair command.

## 6) Conflict Recovery During Restack

```bash
dub restack
# conflict occurs

# resolve files
git add <resolved-files>

dub restack --continue
```

If you are already mid-operation, use the unified recovery commands:

```bash
dub continue
# or
dub abort
```

## 7) Open PR Quickly

```bash
dub pr
# or
dub pr feat/top
# or
dub pr 123
```

## 8) Recover from Mistakes

```bash
dub undo                # undo most recent mutation
dub undo --steps 3      # roll back the last 3
dub undo --list         # inspect the ring
dub redo                # replay the most recently undone op
```

Notes:
- `undo`/`redo` is multi-level (20-entry ring at `.git/dubstack/undo-log.json`).
- Covers `create`, `restack`, `move`, `reorder`, `absorb`, `unlink`, `rename`, `pop`, `modify`, `freeze`/`unfreeze`, `track`/`untrack`, `delete`, `sync`, `split`, and `submit` (PR body restore only — PR retargets and pushes are not reverted).
- A new mutating command clears the redo log.

## 9) Repair Untracked Branch Metadata

```bash
# branch created outside dub create
git checkout feat/manual

dub track feat/manual --parent main

# verify placement
dub parent feat/manual
dub trunk feat/manual
```

## 10) Remove Metadata or Delete Branches Safely

```bash
# metadata-only removal
dub untrack feat/top

# remove branch + descendants from metadata
dub untrack feat/middle --downstack

# delete branch with confirmation
dub delete feat/top

# delete branch and descendants non-interactively
dub delete feat/middle --upstack --force --quiet
```

## 11) Stack Inspection Modes

```bash
dub log --stack
dub log --all
dub log --reverse
```

## 12) Stack Navigation Patterns

```bash
dub up
dub up 2
dub down
dub down --steps 2
dub top
dub bottom
```

## 13) Checkout Patterns

```bash
# interactive
dub checkout

# interactive current stack only
dub checkout --stack

# include untracked branches
dub checkout --show-untracked

# jump to trunk
dub checkout --trunk
```
