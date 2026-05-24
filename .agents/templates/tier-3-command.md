# Template: Tier 3 Command Scaffold

Copy the code block below into a new file at
`packages/cli/src/commands/<name>.ts`, then wire the CLI entry in
`packages/cli/src/index.ts` and the MCP tool in
`packages/cli/src/commands/mcp.ts`.

See [`.agents/patterns/tier-3-commands.md`](../patterns/tier-3-commands.md)
for the *why* behind each piece. Anything marked `// TODO` is a deliberate
hole you must fill before merging.

```ts
import { DubError } from '../lib/errors';
import {
  formatWorktreeCheckoutSkipMessage,
  getCurrentBranch,
  listWorktreeCheckouts,
} from '../lib/git';
import { createProgress, logVerboseCommand } from '../lib/progress';
import { ensureState, readState, writeState } from '../lib/state';
import { saveUndoEntry } from '../lib/undo-log';

/**
 * Options accepted by {@link <commandName>}.
 */
export interface <CommandName>Options {
  /** Skip TTY prompts; required for MCP and CI. */
  interactive?: boolean;
  /** Suppress non-essential stdout. */
  quiet?: boolean;
  /** Print the plan but don't mutate. */
  dryRun?: boolean;
  // TODO: command-specific options (branch name, scope flags, etc.)
}

export async function <commandName>(
  cwd: string,
  options: <CommandName>Options = {},
): Promise<void> {
  await ensureState(cwd);
  const state = await readState(cwd);
  const currentBranch = await getCurrentBranch(cwd);

  // 1) Resolve scope + validate context. Fail fast with actionable hints.
  const targets = resolveTargets(state, currentBranch /*, options */);
  if (targets.length === 0) {
    throw new DubError('Nothing to <verb>.', [
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
        formatWorktreeCheckoutSkipMessage(branch, otherWorktree, 'dub <cmd>'),
      );
      continue;
    }
    safeTargets.push(branch);
  }

  // 3) Dry-run path: print the plan and exit.
  if (options.dryRun) {
    console.log(`Would <verb> ${safeTargets.length} branch(es):`);
    for (const b of safeTargets) console.log(`  - ${b}`);
    return;
  }

  // 4) Snapshot undo BEFORE the first mutation.
  await saveUndoEntry(
    {
      operation: '<command-name-as-operation>', // TODO: extend UndoEntry.operation if new
      timestamp: new Date().toISOString(),
      previousBranch: currentBranch,
      previousState: structuredClone(state),
      branchTips: {}, // TODO: snapshot tips for any branch you'll move
      createdBranches: [],
    },
    cwd,
  );

  // 5) Drive a progress bar through the mutation loop.
  const progress = createProgress();
  progress.start('<Verb>ing', safeTargets.length);
  try {
    for (const [i, branch] of safeTargets.entries()) {
      progress.update(`<Verb>ing ${branch}`, i, '');
      logVerboseCommand('<sub-command>', [branch]);
      // TODO: do the work via the appropriate lib/git.ts or lib/github.ts
      //       helper. Do NOT leave raw `execa('git', ...)` or `execa('gh', ...)`
      //       in your command — wrap new git/gh operations in a helper first
      //       so retry + DubError messaging stays consistent. The lint rules
      //       block `execa('gh', ...)` and raw `git push --force` outright.
      await doWork(branch, cwd);
    }
    progress.complete('<Verb> complete');
  } catch (err) {
    progress.stop();
    throw new DubError(
      err instanceof Error ? err.message : String(err),
      [
        "Run 'dub undo' to roll back to the pre-<verb> state.",
        "Run 'dub doctor' to inspect repo + stack health.",
      ],
    );
  }

  // 6) Persist any state mutations.
  await writeState(state, cwd);
}

function resolveTargets(
  _state: Awaited<ReturnType<typeof readState>>,
  _currentBranch: string,
): string[] {
  // TODO: walk the stack and return branch names this command should touch.
  return [];
}

async function doWork(_branch: string, _cwd: string): Promise<void> {
  // TODO: implement using lib/git.ts and lib/github.ts helpers. Add a new
  //       helper to lib/ if no existing one fits — never call execa('gh', ...)
  //       or run a raw `git push --force` from a command file.
}
```

## Wire-Up Checklist

After dropping the file in place:

1. **CLI entry** (`packages/cli/src/index.ts`):
   ```ts
   import { <commandName> } from './commands/<name>';
   // ...
   program
     .command('<name>')
     .description('<one-line description>')
     .option('--dry-run', "Print the plan without mutating.")
     .action(async (options) => {
       await <commandName>(process.cwd(), options);
     });
   ```

2. **MCP tool** (`packages/cli/src/commands/mcp.ts`):
   - Add `dubstack.<name>` to the `TOOLS` list with `mutating: true` if it
     writes state.
   - Add a `case 'dubstack.<name>':` branch in `callTool` that delegates via
     `mutatingToolResult(() => <commandName>(cwd, { interactive: false, quiet: true }))`.

3. **Tests**:
   - `packages/cli/src/commands/<name>.test.ts` — unit happy + error paths.
   - `packages/cli/test/<name>.integration.test.ts` — cross-command if it
     touches state visible to other commands.

4. **Docs**:
   - Add a usage block in `README.md` and `QUICKSTART.md`.

5. **Verify**:
   - `pnpm test`
   - `pnpm typecheck`
   - `pnpm checks` (lint rules will catch missing `recovery`, raw `execa('gh',
     ...)`, and raw `git push --force`).
