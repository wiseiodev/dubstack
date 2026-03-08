---
name: beads
description: Use when tracking work in this repo with bd/beads, especially to find ready issues, create follow-up tasks, wire dependencies, or structure epics and child tasks correctly.
---

# Beads Issue Tracking

Use this skill whenever work in this repository needs to be tracked or updated in `bd`.

This repo uses `bd` for all task tracking. Do not create markdown TODO lists or ad hoc tracking notes when an issue should exist instead.

## When To Use

- starting work and needing the next unblocked issue
- claiming an issue before implementation
- creating follow-up work discovered during coding or review
- sequencing tasks with blockers
- grouping tasks under an epic
- closing work after verification

## Core Workflow

1. Find ready work:

```bash
bd ready --json
```

2. Claim the issue you are taking:

```bash
bd update <id> --claim --json
```

3. Inspect details before changing the graph:

```bash
bd show <id> --json
```

4. Create newly discovered work with provenance:

```bash
bd create "Title" \
  --description="Why this work exists, scope, acceptance" \
  -t task \
  -p 2 \
  --deps discovered-from:<parent-id> \
  --json
```

5. Add true execution blockers when order matters:

```bash
bd dep add <blocked-id> <blocker-id> --json
```

6. Close finished work:

```bash
bd close <id> --reason "Completed" --json
```

## Dependency Rules That Matter

### `discovered-from` is provenance, not scheduling

Use `--deps discovered-from:<id>` to show where new work came from. This is useful for traceability, but it does not express execution order.

### Blocking dependencies are directional

This command:

```bash
bd dep add <blocked-id> <blocker-id> --json
```

means:
- `<blocked-id>` depends on `<blocker-id>`
- `<blocker-id>` must finish first

Equivalent shorthand:

```bash
bd dep <blocker-id> --blocks <blocked-id> --json
```

Use whichever form is clearer in the moment, but double-check the direction before pressing enter.

### Epics do not block tasks

`bd` will reject epic-to-task blockers. If you want a task to belong to an epic, attach it as a child:

```bash
bd update <child-id> --parent <epic-id> --json
```

Use this pattern:
- `parent-child` for epic grouping
- `dep add` for task sequencing

### Sequence child tasks explicitly

If task B should wait for task A, add a blocker even if both share the same epic:

```bash
bd dep add <task-b> <task-a> --json
```

Parentage alone does not create execution order.

## Recommended Patterns

### Start a new stream of work

```bash
bd create "Ship feature epic" -t epic -p 1 --json
bd create "Implement first task" --deps discovered-from:<epic-id> -t task -p 1 --json
bd update <task-id> --parent <epic-id> --json
```

### Add a follow-up discovered during implementation

```bash
bd create "Handle template edge case" \
  --description="Found while implementing AI metadata support. Capture the edge case and acceptance criteria." \
  -t task \
  -p 2 \
  --deps discovered-from:<current-issue> \
  --json
```

Then decide whether it also needs to block another issue:

```bash
bd dep add <blocked-id> <new-issue-id> --json
```

### Verify your graph

Use:

```bash
bd show <id> --json
bd ready --json
```

`bd dep tree <id>` is useful for blocker chains, but it is not the best way to verify epic child membership.

## Practical Lessons From This Repo

- Always use `--json` for machine-readable output.
- Prefer serial `bd` writes. Parallel reads are usually fine, but parallel writes can trigger avoidable Dolt hiccups.
- If `bd` reports that the Dolt server auto-started but is unreachable, retry the command once and inspect [`.beads/dolt-server.log`](/Users/wise/dev/dubstack/.beads/dolt-server.log) if it repeats.
- `nothing to commit` warnings can appear in Dolt logs during normal `bd` activity; focus on whether the requested issue change actually landed.
- Use clear descriptions with scope, constraints, and acceptance criteria so the next agent can execute without guesswork.

## Quick Reference

| Intent | Command |
|---|---|
| Find unblocked work | `bd ready --json` |
| Claim work | `bd update <id> --claim --json` |
| Inspect an issue | `bd show <id> --json` |
| Create a task | `bd create "Title" ... --json` |
| Link discovered work | `--deps discovered-from:<id>` |
| Make B wait on A | `bd dep add <b> <a> --json` |
| Attach task to epic | `bd update <task> --parent <epic> --json` |
| Close work | `bd close <id> --reason "Completed" --json` |

## Common Mistakes

- Creating a follow-up issue without `discovered-from`, which loses provenance.
- Using epic parentage as if it also enforced execution order.
- Reversing blocker direction in `bd dep add`.
- Trying to make an epic block a task instead of attaching the task as a child.
- Leaving an issue unclaimed while starting implementation.
