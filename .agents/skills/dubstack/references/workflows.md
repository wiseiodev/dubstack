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
dub sync --restack
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
dub merge-next

# repeat until complete
dub merge-next
```

If manual merges happened:

```bash
dub post-merge
```

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
dub undo
```

Notes:
- `undo` supports one level.
- Intended for reverting last `create` or `restack`.

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
