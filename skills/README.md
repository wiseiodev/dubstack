# DubStack Agent Skills

This directory contains agent skills for developing with the DubStack CLI. These skills teach AI agents how to correctly use `dub` commands for stacked PR workflows.

## Available Skills

### `dubstack`
**Reference & Command Guide**
The core skill containing the full `dub` CLI reference, workflows, and troubleshooting. Agents use this to understand how to operate the tool generally (navigating stacks, restacking, checking logs).

```bash
npx skills add wiseiodev/dubstack/skills/dubstack
```

### `dub-flow`
**PR Creation Workflow**
A specialized workflow skill for analyzing staged changes, suggesting branch names/commit messages, and executing a "create branch + commit + submit PR" flow in one go.

```bash
npx skills add wiseiodev/dubstack/skills/dub-flow
```

## Usage

Once installed, your agent will be able to:

- Create stacked branches with `dub create -am`
- Visualize stacks with `dub log`
- Handle restacking across multiple branches
- Submit entire stacks to GitHub with `dub ss`
- Recover from errors using `dub undo`
