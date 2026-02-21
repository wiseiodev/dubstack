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
```

If you need deterministic non-interactive behavior:

```bash
dub sync --no-interactive
```

If you explicitly want destructive reconciliation:

```bash
dub sync --force
```

## 4) Conflict Recovery During Restack

```bash
dub restack
# conflict occurs

# resolve files
git add <resolved-files>

dub restack --continue
```

## 5) Open PR Quickly

```bash
dub pr
# or
dub pr feat/top
# or
dub pr 123
```

## 6) Recover from Mistakes

```bash
dub undo
```

Notes:
- `undo` supports one level.
- Intended for reverting last `create` or `restack`.

## 7) Stack Navigation Patterns

```bash
dub up
dub up 2
dub down
dub down --steps 2
dub top
dub bottom
```

## 8) Checkout Patterns

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
