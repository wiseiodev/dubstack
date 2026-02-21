# Dub UX Command Parity Design

**Date:** 2026-02-21  
**Status:** Draft (ready for implementation planning)  
**Owner:** DubStack CLI

## 1. Problem

DubStack already supports core stacked-PR flows, but non-power-git users still hit avoidable friction when stacks drift or metadata gets out of sync.

Graphite's strongest UX advantage is not only command breadth, but recovery-oriented ergonomics:
- clear commands for repairing branch metadata,
- safe defaults with guided prompts,
- consistent continuation/abort flows,
- plain-language explanations of what happened and what to run next.

DubStack should prioritize this same "help me recover" experience.

## 2. Target User

Primary user profile:
- comfortable with `git checkout`, `git add`, `git commit`
- not comfortable with manual rebases, parent rewiring, or metadata repair
- expects CLI to suggest safe next steps when things are wrong

Design implication:
- optimize for clear guided workflows over minimal command count
- keep dangerous actions explicit (`--force`) and default-safe

## 3. UX Principles

1. **Safe by default**
- non-interactive mode should skip risky actions and explain why

2. **Guided repair over raw errors**
- every failure should suggest a next command (`dub continue`, `dub restack --continue`, `dub track ...`)

3. **Single mental model for interrupted operations**
- same continuation/abort semantics across sync/restack/repair flows

4. **Graphite-style muscle memory where it improves outcomes**
- match naming/behavior where practical (`track`, `delete`, `parent`, `children`, `continue`, `abort`)

5. **Plain language first**
- avoid jargon-heavy messages when user intent can be inferred

## 4. Priority Command Additions and Upgrades

## P0 (highest UX impact)

### 4.1 `dub track [branch]`

Purpose:
- start tracking existing local branches
- fix parent metadata for already tracked branches

Proposed surface:
```bash
dub track                    # track current branch (interactive parent prompt)
dub track feat/a             # track explicit branch
dub track --parent main      # set explicit parent
dub track feat/a --parent feat/base
```

Behavior:
- validates branch exists locally
- if already tracked and parent changes, prints a clear "re-parented" summary
- if branch has descendants, prompt whether to restack now

Why this matters:
- this is the easiest fix path when users create branches outside `dub create`

### 4.2 `dub untrack [branch]`

Purpose:
- remove branch from Dub metadata without deleting git branch

Proposed surface:
```bash
dub untrack
dub untrack feat/a
dub untrack feat/a --downstack
```

Behavior:
- warns if descendants exist
- `--downstack` untracks descendants recursively
- never deletes branch content

### 4.3 `dub delete [branch]`

Purpose:
- stack-aware branch deletion with safe prompts

Proposed surface:
```bash
dub delete feat/a
dub delete feat/a --upstack
dub delete feat/a --downstack
dub delete feat/a --force --quiet
```

Behavior:
- re-parents children to deleted branch's parent when possible
- if branch has unmerged commits, prompt unless `--force`
- always prints resulting stack shape summary

Why this matters:
- non-power users should not need manual `git branch -D` + metadata cleanup

### 4.4 `dub continue` and `dub abort`

Purpose:
- one obvious recovery pair for paused operations

Proposed surface:
```bash
dub continue
dub abort
```

Behavior:
- `continue`: resumes known paused operation (restack/sync-rebase)
- `abort`: safely aborts paused rebase operation and restores pre-op state where possible
- if no operation is paused, emits actionable message

Why this matters:
- users currently need to remember low-level git rebase steps

### 4.5 `dub parent`, `dub children`, `dub trunk`

Purpose:
- quick orientation commands

Proposed surface:
```bash
dub parent
dub children
dub trunk
```

Behavior:
- simple outputs with optional `--json` in future
- clear errors for untracked context with recommended `dub track`

Why this matters:
- reduces confusion about where branch sits in stack

## P1 (major UX upgrades to existing commands)

### 4.6 `dub submit` UX upgrade

Current gaps vs Graphite UX:
- less guidance around what will be pushed/updated and why
- fewer beginner-safe confirmation flows

Upgrade goals:
- richer preview mode (`--dry-run` + branch-by-branch intent)
- clearer failure messages for auth, non-linear stack, restack requirement
- optional `--confirm` style prompt for destructive pushes (future)

### 4.7 `dub log` modes

Add lightweight modes inspired by Graphite clarity:
```bash
dub log --stack
dub log --all
dub log --reverse
```

Goal:
- easier reading in larger repos/multiple stacks

### 4.8 `dub create` assisted mode

Future enhancement:
- allow omitted branch name with guided prompt and suggested branch slug

## P2 (advanced stack surgery)

### 4.9 `dub move` / `dub reorder`

Purpose:
- safely reorder stack branches without manual rebase expertise

Potential surface:
```bash
dub move --onto <branch>
dub reorder
```

This is high value but should come after `track/delete/continue` foundation.

## 5. Recovery UX Patterns (Cross-Command)

Every repair-capable command should follow this output pattern:

1. What happened
2. What Dub did
3. What to run next

Example:
```text
⚠ Branch 'feat/a' is untracked.
Run 'dub track feat/a --parent main' to include it in stack operations.
```

Non-interactive skip pattern:
```text
⚠ Skipped '<branch>' in non-interactive mode (requires confirmation).
Re-run with --interactive or --force.
```

## 6. Metrics and Success Criteria

Product metrics:
- reduced support issues involving "stack broken" and "unknown parent"
- reduced manual git command usage in recovery flows
- faster time from error to successful submission

Engineering success criteria:
- all P0 commands implemented with tests
- clear deterministic behavior in `--no-interactive`
- docs updated with recovery playbooks

## 7. Rollout Strategy

Phase 1 (P0 core recovery):
- `track`, `untrack`, `delete`, `continue`, `abort`, `parent/children/trunk`

Phase 2 (P1 UX depth):
- `submit` preview/confirm improvements
- `log` modes
- `create` assisted naming

Phase 3 (P2 advanced surgery):
- `move` / `reorder`

## 8. Risks

1. Metadata corruption during re-parent/delete flows  
Mitigation: strict state invariants + migration/repair tests

2. Overly destructive defaults  
Mitigation: prompt-by-default + explicit `--force`

3. Command surface bloat  
Mitigation: prioritize recovery commands and maintain clear docs/help examples

## 9. Recommendation

Start with P0 immediately. These are the commands that most directly convert confusion into guided success for non-power-git users and best capture Graphite's UX advantage.
