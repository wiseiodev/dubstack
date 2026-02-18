# DubStack Quick Start

A walkthrough from zero to stacked PRs.

## 1. Setup

```bash
npm install -g dubstack   # or: pnpm add -g dubstack
```

No `dub init` needed — DubStack auto-initializes on first use.

## 2. Create Your First Stack

You're on `main` with some code changes ready to go:

```bash
# Stage all + create branch + commit in one shot
dub create feat/auth-types -am "feat: add auth types and interfaces"
# ✔ Created 'feat/auth-types' on 'main' • feat: add auth types and interfaces
```

Now make more changes and stack another branch:

```bash
# Write login logic...
dub create feat/auth-login -am "feat: add login flow"
# ✔ Created 'feat/auth-login' on 'feat/auth-types' • feat: add login flow
```

And a third:

```bash
# Write tests...
dub create feat/auth-tests -am "test: add auth test suite"
# ✔ Created 'feat/auth-tests' on 'feat/auth-login' • test: add auth test suite
```

Your stack is now: `main → feat/auth-types → feat/auth-login → feat/auth-tests`

## 3. View the Stack

```bash
dub log
```

```
main
  └─ feat/auth-types
       └─ feat/auth-login
            └─ *feat/auth-tests (Current)*
```

## 4. Submit PRs

Push all branches and create GitHub PRs for the entire stack:

```bash
dub ss
# ✔ Pushed 3 branch(es), created 3 PR(s), updated 0 PR(s)
#   ↳ feat/auth-types
#   ↳ feat/auth-login
#   ↳ feat/auth-tests
```

Each PR targets its parent branch, so reviewers see only the diff for that layer.

> **Tip:** Preview what would happen without acting: `dub ss --dry-run`

## 5. Iterate on Review Feedback

Reviewer asks for changes on `feat/auth-login`:

```bash
git checkout feat/auth-login
# Make your edits...
git add -A && git commit -m "fix: address review feedback"

# Restack the branches above (so feat/auth-tests picks up the change)
dub restack

# Push everything again
dub ss
```

## 6. After a PR Merges

When `feat/auth-types` gets merged into `main`:

```bash
git checkout main
git pull

# Restack: feat/auth-login now targets main directly
dub restack

# Update the remaining PRs
dub ss
```

## 7. Undo Mistakes

Created the wrong branch? DubStack remembers:

```bash
dub undo
# ✔ Undid 'create': Deleted branch 'feat/oops', restored state
```

## Command Reference

| Command | Description |
|---------|-------------|
| `dub create <name>` | Create branch only |
| `dub create <name> -m "msg"` | Create branch + commit staged |
| `dub create <name> -am "msg"` | Stage all + create + commit |
| `dub log` | Show stack tree |
| `dub ss` | Push + create/update all PRs |
| `dub submit --dry-run` | Preview submit |
| `dub restack` | Rebase all branches onto parents |
| `dub undo` | Reverse last operation |
