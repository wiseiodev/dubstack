# Template: Tier 3 Command Scaffold

Copy the code block below into a new file at
`packages/cli/src/commands/<name>.ts`, then rename every identifier or string
marked with `RENAME:`, fill every `TODO:`, and wire the CLI entry in
`packages/cli/src/index.ts` plus the MCP tool in
`packages/cli/src/commands/mcp.ts`.

The snippet is valid TypeScript as written — it compiles, typechecks, and
lints cleanly — so a search-and-replace on `myCommand` / `MyCommandOptions` /
`'verb'` / `'my-command'` is enough to get to a real command before you start
filling the `TODO:` holes.

See [`.agents/patterns/tier-3-commands.md`](../patterns/tier-3-commands.md)
for the *why* behind each piece.

```ts
import { DubError } from '../lib/errors';
import {
  formatWorktreeCheckoutSkipMessage,
  getCurrentBranch,
  listWorktreeCheckouts,
} from '../lib/git';
import { createProgress, logVerboseCommand } from '../lib/progress';
import { type DubState, ensureState, readState, writeState } from '../lib/state';
import { saveUndoEntry } from '../lib/undo-log';

// RENAME: pick a verb that matches the command's user-facing name.
const VERB = 'verb';
// RENAME: pick the subprocess label that appears under --verbose.
const SUB_COMMAND_LABEL = 'my-command';

/**
 * Options accepted by {@link myCommand}.
 *
 * RENAME `MyCommandOptions` and `myCommand` to the new command's name.
 */
export interface MyCommandOptions {
  /** Skip TTY prompts; required for MCP and CI. */
  interactive?: boolean;
  /** Suppress non-essential stdout. */
  quiet?: boolean;
  /** Print the plan but don't mutate. */
  dryRun?: boolean;
  // TODO: command-specific options (branch name, scope flags, etc.).
}

export async function myCommand(
  cwd: string,
  options: MyCommandOptions = {},
): Promise<void> {
  await ensureState(cwd);
  const state = await readState(cwd);
  const currentBranch = await getCurrentBranch(cwd);

  // 1) Resolve scope + validate context. Fail fast with actionable hints.
  const targets = resolveTargets(state, currentBranch /*, options */);
  if (targets.length === 0) {
    throw new DubError(`Nothing to ${VERB}.`, [
      // TODO: explain *why* nothing matched and what to do next.
      "Run 'dub log' to see tracked branches.",
    ]);
  }

  // 2) Skip branches checked out in another worktree.
  const checkouts = await listWorktreeCheckouts(cwd);
  const safeTargets: string[] = [];
  for (const branch of targets) {
    const otherWorktree = checkouts.get(branch);
    if (otherWorktree) {
      console.log(
        formatWorktreeCheckoutSkipMessage(
          branch,
          otherWorktree,
          `dub ${SUB_COMMAND_LABEL}`,
        ),
      );
      continue;
    }
    safeTargets.push(branch);
  }

  // 3) Dry-run path: print the plan and exit.
  if (options.dryRun) {
    console.log(`Would ${VERB} ${safeTargets.length} branch(es):`);
    for (const b of safeTargets) console.log(`  - ${b}`);
    return;
  }

  // 4) Snapshot undo BEFORE the first mutation.
  await saveUndoEntry(
    {
      // TODO: extend UndoEntry.operation in lib/undo-log.ts to include this
      //       command's name, then replace the cast below.
      operation: 'create' as UndoEntry['operation'],
      timestamp: new Date().toISOString(),
      previousBranch: currentBranch,
      previousState: structuredClone(state),
      branchTips: {}, // TODO: snapshot tips for any branch you'll move.
      createdBranches: [],
    },
    cwd,
  );

  // 5) Drive a progress bar through the mutation loop. Use a 1-based counter
  //    so the bar shows progress on the first step instead of starting at 0
  //    (matches the pattern in commands/sync.ts and commands/submit.ts).
  const progress = createProgress();
  progress.start(`${capitalize(VERB)}ing`, safeTargets.length);
  let processed = 0;
  try {
    for (const branch of safeTargets) {
      processed += 1;
      progress.update(`${capitalize(VERB)}ing ${branch}`, processed, '');
      logVerboseCommand(SUB_COMMAND_LABEL, [branch]);
      // TODO: do the work via the appropriate lib/git.ts or lib/github.ts
      //       helper. Do NOT leave raw `execa('git', ...)` or `execa('gh', ...)`
      //       in your command — wrap new git/gh operations in a helper first
      //       so retry + DubError messaging stays consistent. The lint rules
      //       block `execa('gh', ...)` and raw `git push --force` outright.
      await doWork(branch, cwd);
    }
    progress.complete(`${capitalize(VERB)} complete`);
  } catch (err) {
    progress.stop();
    throw new DubError(err instanceof Error ? err.message : String(err), [
      `Run 'dub undo' to roll back to the pre-${VERB} state.`,
      "Run 'dub doctor' to inspect repo + stack health.",
    ]);
  }

  // 6) Persist any state mutations.
  await writeState(state, cwd);
}

function resolveTargets(_state: DubState, _currentBranch: string): string[] {
  // TODO: walk the stack and return branch names this command should touch.
  return [];
}

async function doWork(_branch: string, _cwd: string): Promise<void> {
  // TODO: implement using lib/git.ts and lib/github.ts helpers. Add a new
  //       helper to lib/ if no existing one fits — never call execa('gh', ...)
  //       or run a raw `git push --force` from a command file.
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
}

// Import alongside the others above; broken out here so the example reads
// top-to-bottom. The `as UndoEntry['operation']` cast in step 4 is a stop-gap:
// extend the union in lib/undo-log.ts before merging your new command.
import type { UndoEntry } from '../lib/undo-log';
```

## Wire-Up Checklist

After dropping the file in place:

1. **CLI entry** (`packages/cli/src/index.ts`):
   ```ts
   import { myCommand } from './commands/my-command';
   // ...
   program
     .command('my-command')
     .description('One-line description shown in `dub --help`.')
     .option('--dry-run', 'Print the plan without mutating.')
     .action(async (options) => {
       await myCommand(process.cwd(), options);
     });
   ```

2. **MCP tool** (`packages/cli/src/commands/mcp.ts`):
   - Add `dubstack.my-command` to the `TOOLS` list with `mutating: true` if
     it writes state.
   - Add a `case 'dubstack.my-command':` branch in `callTool` that delegates
     via `mutatingToolResult(() => myCommand(cwd, { interactive: false, quiet: true }))`.

3. **Tests**:
   - `packages/cli/src/commands/my-command.test.ts` — unit happy + error paths.
   - `packages/cli/test/my-command.integration.test.ts` — cross-command if it
     touches state visible to other commands.

4. **Docs**:
   - Add a usage block in `README.md` and `QUICKSTART.md`.

5. **Verify**:
   - `pnpm test`
   - `pnpm typecheck`
   - `pnpm checks` (lint rules will catch missing `recovery`, raw `execa('gh',
     ...)`, and raw `git push --force`).
