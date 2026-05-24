# Pattern: Tier 3 Commands

Use this pattern for every new Tier 3 command. The same Tier 0 plumbing must
appear in every command that touches git + state. Lint rules in
`biome-plugins/` enforce the three most error-prone pieces — the rest is on
you.

Scaffold template lives at [`.agents/templates/tier-3-command.md`](../templates/tier-3-command.md).

## 1) DubError With Recovery

Every user-facing failure must carry actionable next steps.

```ts
import { DubError } from '../lib/errors';

throw new DubError(`Branch '${name}' is not tracked.`, [
  `Run 'dub track ${name}' to add it to the current stack.`,
  "Run 'dub log' to see the tracked branches.",
]);
```

Import from `packages/cli/src/lib/errors.ts`.

**Don't:**

- `throw new DubError('Boom.')` or `throw new DubError('Boom.', [])` — both
  are blocked by lint rule `no-bare-duberror`. Pass a non-empty `string[]`
  of recovery hints.
- Use a generic `Error` for user-facing failures; the CLI prints those as
  unhandled stack traces.

**The user-cancelled exception.** When the user explicitly cancels (e.g.
declines an interactive prompt) there is genuinely nothing to recover. Use
the sanctioned sentinel instead of a bare construction:

```ts
throw DubError.cancelled(); // defaults to "Cancelled."
throw DubError.cancelled('Aborted by user.');
```

## 2) retry() For Flaky Operations

Wrap any network or external-tool call that can transiently fail
(`gh`, `git fetch`, `git push`, remote PR API). `retry` does exponential
backoff with jitter and supports `isPermanent` short-circuits.

```ts
import { retry } from '../lib/retry';

await retry(() => execa('git', ['fetch', 'origin']), {
  isPermanent: (err) => isAuthFailure(err),
  onRetry: (attempt, err) => logVerboseCommand(`retry ${attempt}`, [String(err)]),
});
```

Import from `packages/cli/src/lib/retry.ts`.

**Don't:**

- Wrap deterministic local-only operations (state reads, `git rev-parse`) —
  retry only buys you noise.
- Forget `isPermanent` for `gh` / `git` failures that will never recover
  (HTTP 401/403/404, missing refs); without it you'll wait 4 attempts to fail.

## 3) createProgress() For Multi-Step Work

Any command that does ≥ 2 user-visible steps should drive a progress bar.
TTY/CI detection is automatic — non-TTY environments get a no-op.

```ts
import { createProgress } from '../lib/progress';

const progress = createProgress();
progress.start('Restacking', branches.length);
let processed = 0;
try {
  for (const branch of branches) {
    processed += 1;
    progress.update(`Restacking ${branch}`, processed, '');
    await restackBranch(branch);
  }
  progress.complete('Restack complete');
} catch (err) {
  progress.stop(); // never leave the cursor hidden on error
  throw err;
}
```

Use a 1-based counter that increments *before* `progress.update` so the bar
shows progress on the first step. This matches the convention in
`commands/sync.ts` and `commands/submit.ts`; a 0-based index from
`entries()` makes the first frame render as `0/N`.

Import from `packages/cli/src/lib/progress.ts`.

**Don't:**

- Log `console.log` lines mid-progress — they will be eaten by the bar.
  Use `logVerboseCommand` (also in `progress.ts`) or `progress.pause()`
  around the write.
- Forget `progress.stop()` in error paths; an uncaught throw leaves the
  terminal cursor hidden.

## 4) --force-with-lease Discipline

Pushes use the existing `pushBranch` helper, which scopes
`--force-with-lease` to our locally tracked `refs/dubstack/last-pushed/<branch>`.
Never construct a push by hand.

```ts
import { pushBranch } from '../lib/git';

await pushBranch(branch, cwd, {
  onRetry: (attempt, err) =>
    logVerboseCommand(`push retry ${attempt}`, [String(err)]),
});
```

Import from `packages/cli/src/lib/git.ts`.

**Don't:**

- `execa('git', ['push', '--force', ...])` — lint rule `no-direct-force-push`
  blocks it. Bare `--force` races with teammate pushes.
- `execa('git', ['push', '--force-with-lease', ...])` without our tracked
  ref — `refs/remotes/origin/*` is silently updated by background fetches,
  defeating the lease.

## 5) Worktree-Aware Mutations

Any command that mutates a branch (rename, restack, delete, sync) must skip
branches checked out in another worktree — `git branch -m` and friends fail
mid-op otherwise, and recovery is messy.

```ts
import {
  formatWorktreeCheckoutSkipMessage,
  listWorktreeCheckouts,
} from '../lib/git';

const checkouts = await listWorktreeCheckouts(cwd);
for (const branch of targets) {
  const otherWorktree = checkouts.get(branch);
  if (otherWorktree) {
    console.log(formatWorktreeCheckoutSkipMessage(branch, otherWorktree, 'dub <cmd>'));
    continue;
  }
  await mutate(branch);
}
```

Import from `packages/cli/src/lib/git.ts`.

**Don't:**

- Skip the check on commands that mutate branches; users running DubStack
  across worktrees will hit confusing mid-op failures.
- Hard-fail when a single branch is checked out elsewhere — skip with the
  shared message and continue with the rest.

## 6) Undo Entry For State-Mutating Commands

Any command that changes `.git/dubstack/state.json` or recreates a branch
ref must persist an undo snapshot first. `dub undo` reads the latest entry.

```ts
import { saveUndoEntry } from '../lib/undo-log';

await saveUndoEntry(
  {
    operation: 'rename',
    timestamp: new Date().toISOString(),
    previousBranch: currentBranch,
    previousState: structuredClone(state),
    branchTips: { [branch]: await getBranchTip(branch, cwd) },
    createdBranches: [],
  },
  cwd,
);
```

Import from `packages/cli/src/lib/undo-log.ts`.

**Don't:**

- Save the undo entry *after* the mutation — a crash in between leaves the
  user with no rollback path.
- Mutate `previousState` in place — always `structuredClone(state)` so the
  snapshot survives later edits.

## 7) MCP Tool Exposure

Every Tier 3 command should ship a matching `dubstack.<cmd>` MCP tool entry
in `packages/cli/src/commands/mcp.ts`. AI clients invoke commands through
this surface, so a missing entry silently strands the feature.

In `mcp.ts`, add the tool to the `TOOLS` list, wire its input schema, and
add a `case 'dubstack.<cmd>':` branch in `callTool` that delegates to your
command function. Set `mutating: true` for any command that writes git
state — the MCP wrapper will route it through `mutatingToolResult` and
prompt for confirmation.

```ts
// commands/mcp.ts
case 'dubstack.<cmd>':
  return mutatingToolResult(() =>
    <yourCommand>(cwd, {
      branch: optionalString(args.branch),
      interactive: false,
      quiet: true,
    }),
  );
```

**Don't:**

- Add the case branch but forget the tool entry in `TOOLS` — `tools/list`
  won't surface it.
- Throw a bare `DubError` from the MCP branch; the lint rule will flag it
  and AI clients lose the recovery context.

## 8) gh Calls Go Through runGh

`runGh` (private to `lib/github.ts`) wraps `execa('gh', …)` with retry +
permanent-error classification. Anywhere outside `github.ts` that needs PR
data should call one of the exported helpers (`getPr`, `getBranchPrSyncInfo`,
`retargetPrBase`, etc.) — those are the canonical surface.

```ts
import { getPr } from '../lib/github';

const pr = await getPr(branch, cwd);
```

**Don't:**

- `execa('gh', ...)` directly from a command file — lint rule
  `no-direct-execa-gh` blocks it. Direct calls skip retry and classify nothing,
  so transient flakes surface as user-facing errors.
- Add new `runGh` callers outside `github.ts`; expose a new helper instead so
  retry + classification + DubError messaging stays consistent.

## 9) Cleanup Journal For Multi-Step git+state Mutations

If your command does more than one mutation that spans both git and state
(delete + reparent + retarget, etc.), record a `CleanupJournal` so `dub
continue` can resume after a crash.

```ts
import {
  appendCleanupOperation,
  clearCleanupJournal,
  startCleanupJournal,
} from '../lib/cleanup-journal';

const journal = await startCleanupJournal(cwd);
try {
  for (const op of plan) {
    await appendCleanupOperation(cwd, journal, op);
    await applyOperation(op);
  }
  await clearCleanupJournal(cwd);
} catch (err) {
  // Journal stays on disk; `dub continue` will replay idempotently.
  throw err;
}
```

Import from `packages/cli/src/lib/cleanup-journal.ts`.

**Don't:**

- Clear the journal in a `finally` block; the whole point is that a crash
  leaves it on disk for `dub continue`.
- Make `applyOperation` non-idempotent — replay must be safe to run twice.

## Lint Rules

Three Biome GritQL plugins enforce the most error-prone rules above. See
`biome-plugins/`:

| Rule                    | Blocks                                                                  | Allowed in / Escape hatch |
| ----------------------- | ----------------------------------------------------------------------- | ------------------------- |
| `no-bare-duberror`      | `new DubError(msg)` and `new DubError(msg, [])` (empty recovery)        | `lib/errors.ts`, `*.test.ts`; use `DubError.cancelled(msg)` for the user-cancelled case |
| `no-direct-execa-gh`    | `execa('gh', …)` outside the `runGh` wrapper                            | `lib/github.ts` |
| `no-direct-force-push`  | `git push --force` without `--force-with-lease`                         | `lib/git.ts` (pushBranch) |

Run with `pnpm checks` (rules run as part of `biome check`).

## Verification

Run from repo root:

1. `pnpm test`
2. `pnpm typecheck`
3. `pnpm checks`
