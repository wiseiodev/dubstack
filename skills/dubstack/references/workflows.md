# DubStack Workflows

## Creating a Stack

```bash
# Start from trunk
dub co main
git pull

# Create first branch + commit
dub create feat/auth-base -am "feat: add auth types"

# Stack second branch on top
dub create feat/auth-login -am "feat: add login flow"

# Stack third branch
dub create feat/auth-tests -am "test: add auth tests"

# Submit entire stack
dub ss
```

## Updating a Branch in the Stack

Scenario: You need to fix something in the middle branch `feat/auth-login`.

```bash
# Checkout the branch (use interactive picker if name forgotten: `dub co`)
dub co feat/auth-login

# Make changes
git add .
git commit -m "fix: address review feedback"

# Update upstack branches (feat/auth-tests) to build on your fix
dub restack

# Submit changes
dub ss
```

## Syncing After Trunk Updates

Scenario: `main` has moved forward, and you need to bring your stack up to date.

```bash
# Update main
dub co main
git pull

# Rebase the entire stack onto the new main
dub restack

# If conflicts occur:
#   1. Resolve files
#   2. git add <files>
#   3. git rebase --continue
#   4. Repeat until done
```

## Handling Merged PRs

Scenario: The bottom branch `feat/auth-base` has been merged into `main`.

```bash
# Update main
dub co main
git pull

# Restack remaining branches
# DubStack detects that feat/auth-login's parent (feat/auth-base) is merged
# and rebases it onto main automatically (if history allows), or you may need to manually rebase.
dub restack
```

## Recovering from Mistakes

```bash
# Created the wrong branch or messed up a restack?
dub undo
# Reverts the last 'create' or 'restack' operation state
```
