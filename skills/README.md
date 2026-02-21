# DubStack Skills (Packaged)

DubStack ships agent skills so coding assistants can use `dub` correctly for stacked PR workflows.

## Included Skills

### `dubstack`

General CLI reference and workflow guidance for:
- creating and navigating stacks
- modifying branches and restacking
- syncing with remote state
- submitting PR stacks
- recovering from common errors

Install:

```bash
npx skills add wiseiodev/dubstack/skills/dubstack
```

### `dub-flow`

Task-oriented PR execution flow for agents that need to:
- analyze staged changes
- propose branch + commit naming
- run `dub create` / `dub submit`
- open and polish PR metadata

Install:

```bash
npx skills add wiseiodev/dubstack/skills/dub-flow
```

## Install via Dub CLI

You can also install these directly from DubStack:

```bash
# install all packaged skills
dub skills add

# install specific skill
dub skills add dubstack
dub skills add dub-flow
```

## Remove Skills

```bash
dub skills remove dubstack
dub skills remove dub-flow
```

## Dry Run

```bash
dub skills add --dry-run
dub skills remove --dry-run
```

## What Agents Gain

With these skills installed, agents are more reliable at:
- using stack-safe commands (`create`, `modify`, `sync`, `restack`, `submit`)
- choosing safer recovery paths after conflicts
- avoiding destructive or non-stack-aware git flows
- producing consistent PR workflow outputs
