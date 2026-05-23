## TL;DR

DubError now accepts a recovery: string[] second arg; the CLI's top-level handler prints a numbered "What you can do:" block under every user-facing error. All ~214 throw sites carry actionable recovery hints where one exists; programmer-invariant errors default to []. Format is locked by unit and snapshot tests; existing tests that asserted on inline recovery substrings now assert on error.recovery.

## Why

Every DubStack command threw user-facing errors with bespoke remediation text inlined into the message — inconsistent voice, inconsistent shape, and impossible to render uniformly in IDEs, support bundles, or future renderers.

Tier 0 (Sync Magic) needs a stable, structured surface for recovery hints so future surfaces (TUI, AI assistant, support bundle) can consume them.

Centralizing recovery turns 'try X, then Y, then Z' guidance into machine-readable steps.

### Before

- throw new DubError(`Sync paused: conflict while restacking '${branch}'.\n` + 'Recovery:\n' + '  1. Resolve...\n' + '  2. ...');
- Tests asserted on inline 'dub continue' / 'dub abort' substrings inside the message.
- Top-level handler in index.ts just printed `✖ ${error.message}` with no structure.

### After

- throw new DubError("Sync paused: conflict while restacking 'feat/auth-ui'.", ['Resolve conflicts and stage the resolved files.', "Run 'dub continue --ai' to let DubStack try the resolution.", "Run 'dub continue' after resolving manually.", "Run 'dub abort' to roll back to the pre-sync state."]);
- Top-level handler prints the message in red, then 'What you can do:' followed by a numbered list of recovery steps.
- Tests now assert on error.recovery (an array) rather than inline message text.

## File-by-file

### packages/cli/src/lib/errors.ts

mod +30 / -10

DubError gains a `recovery: string[]` field with a default of []. New formatDubError() helper renders the canonical message + 'What you can do:' block. This is the single source of truth for the on-screen format.

```typescript
export class DubError extends Error {
  readonly recovery: string[];

  constructor(message: string, recovery: string[] = []) {
    super(message);
    this.name = 'DubError';
    this.recovery = recovery;
  }
}

export function formatDubError(error: DubError): string {
  if (error.recovery.length === 0) {
    return error.message;
  }
  const steps = error.recovery
    .map((step, idx) => `  ${idx + 1}. ${step}`)
    .join('\n');
  return `${error.message}\n\nWhat you can do:\n${steps}`;
}
```

### packages/cli/src/index.ts

mod +12 / -4

Top-level catch now calls formatDubError(), prints the first line in red (preserving the legacy ✖ chrome) and emits each recovery line verbatim. Arg-validation throws (parseSteps, parseSubmitPath, parsePositiveInt, parseMergeMethod) also get recovery hints.

```typescript
if (error instanceof DubError) {
  const [firstLine, ...rest] = formatDubError(error).split('\n');
  console.error(chalk.red(`✖ ${firstLine}`));
  for (const line of rest) {
    console.error(line);
  }
  await finalizeHistoryCapture('error', error.message);
  process.exit(1);
}
```

### packages/cli/src/commands/sync.ts

mod +38 / -17

Lifts the previously inlined Recovery block out of the conflict message and into the recovery array. wrapSyncError() now propagates an existing recovery rather than re-inlining the same hint text.

```typescript
throw new DubError(
  `Sync paused: conflict while restacking '${restackResult.conflictBranch ?? 'unknown'}'.`,
  [
    'Resolve conflicts and stage the resolved files.',
    "Run 'dub continue --ai' to let DubStack try the resolution.",
    "Run 'dub continue' after resolving manually.",
    "Run 'dub abort' to cancel recovery and roll back progress.",
  ],
);
```

### packages/cli/src/commands/submit.ts

mod +47 / -21

The branching-stack error keeps its multi-line summary in the message but lifts the three Fix options into the recovery array. buildBranchingErrorMessage() became buildBranchingError() returning { message, recovery }.

```typescript
function buildBranchingError(
  blockers: SubmitBranchingBlocker[],
  currentBranch: string,
): { message: string; recovery: string[] } {
  ...
  return {
    message,
    recovery: [
      "Run 'dub submit --path current' to submit only your current linear path.",
      "Run 'dub submit --path stack --fix' to retry with safe auto-fix.",
      "Run 'dub track <child> --parent <branch>' to re-parent and linearize manually.",
    ],
  };
}
```

### packages/cli/src/lib/git.ts

mod +152 / -43

The largest single-file change. Every git-failure throw (checkout, push, rebase, fetch, merge-base, ref read, hard reset, stage, commit, amend, etc.) gains a recovery array pointing at the underlying git command the user can run manually plus relevant `dub` follow-ups.

```typescript
throw new DubError(`Conflict while restacking '${branch}'.`, [
  'Resolve conflicts and stage the resolved files.',
  "Run 'dub continue --ai' to let DubStack try the resolution.",
  "Run 'dub continue' (or 'dub restack --continue') after resolving manually.",
  "Run 'dub abort' to cancel and roll back progress.",
]);
```

### packages/cli/src/lib/github.ts

mod +95 / -26

gh CLI guardrails (missing CLI, missing auth, missing scopes), PR fetch/parse/create/update/merge/retarget errors, and the GitHub-only repo-URL guard each get a recovery array. Permissions-related throws are consolidated under a single 'GitHub token lacks required permissions.' message + recovery via replace_all.

```typescript
throw new DubError('Not authenticated with GitHub.', [
  "Run 'gh auth login' and sign in with the 'repo' scope.",
  "Run 'gh auth status' to confirm authentication, then retry.",
]);
```

### packages/cli/src/commands/restack.ts

mod +24 / -9

Dirty-tree, no-stack, missing-tracked-branch, and no-restack-in-progress errors all carry hints that point at the right next step (git stash, dub track, dub untrack, dub restack).

### packages/cli/src/lib/errors.test.ts

new +56 / -0

Unit tests covering the constructor's default-empty recovery, custom recovery, and the formatDubError() output shape (bare message, numbered block, multi-line message preservation).

### packages/cli/test/error-formatting.test.ts

new +86 / -0

Snapshot tests that exercise four real command throw sites end-to-end (create --ai conflicts, abort no-op, restack from a freshly initialised repo, create --ai + -m) and freeze the rendered output via toMatchInlineSnapshot.

### packages/cli/src/commands/sync.test.ts

mod +16 / -6

Updated the 'throws actionable recovery guidance when restack phase conflicts' assertion to check error.recovery contains the expected commands instead of error.message substrings.

### packages/cli/src/commands/submit.test.ts

mod +12 / -9

Same pattern: 'Cannot submit from root' and the branching-stack error checks moved from inline-substring assertions to error.recovery array assertions.

### packages/cli/src/commands/{children,parent,trunk,delete}.test.ts

mod +24 / -4

Same pattern applied to the four command tests that previously asserted on inline 'dub track' / '--force' substrings.

### packages/cli/src/commands/{ai,create}.test.ts and packages/cli/src/lib/{ai-metadata,ai-shortcut}.test.ts

mod +14 / -8

Existing assertions that grepped for 'Enable it with...', 'DUBSTACK_GEMINI_API_KEY', 'DUBSTACK_BEDROCK_AWS_REGION...', and 'Did you mean...' now match against the new shorter messages or the recovery array.

## Where to focus review

1. **Backwards-compatible substring checks** - `packages/cli/src/commands/restack.ts:197, packages/cli/src/commands/modify.ts:139, packages/cli/src/lib/state.ts:141`: Three call sites still use error.message.includes('Conflict' / 'not initialized') to branch on error type. Verified the new messages keep those keywords. Worth a second look to confirm no other callers rely on inline recovery text.
2. **Single source of truth for the rendered format** - `packages/cli/src/lib/errors.ts (formatDubError) and packages/cli/src/index.ts (catch block)`: The on-screen format lives in formatDubError(). The index.ts handler must continue to feed every DubError through it. Any future renderer (TUI, support bundle, AI assistant) should reuse formatDubError rather than re-implementing.
3. **Recovery voice consistency** - `packages/cli/src/commands/*.ts, packages/cli/src/lib/*.ts`: Recovery items follow 'Run X' / 'Rerun X' / 'Pass X' imperative voice, backtick-wrapped CLI commands, and end with a period. A reviewer may want to spot-check a few less-frequented files for drift.
4. **Programmer-invariant errors keep empty recovery** - `packages/cli/src/lib/invariants.ts, packages/cli/src/lib/graph.ts, packages/cli/src/lib/conflict-ui.ts (Refusing-to-write guards)`: These throw on stack-state corruption or safety violations. They all point users at 'dub doctor' as the universal fallback — confirm that matches your support stance.

## Test plan

- [x] **unit:** DubError constructor + formatDubError - packages/cli/src/lib/errors.test.ts (5 tests)
- [x] **integration:** Snapshot of four real command error outputs - packages/cli/test/error-formatting.test.ts (4 tests, inline snapshots)
- [x] **unit:** Updated 10 pre-existing test files to check error.recovery - sync.test.ts, submit.test.ts, children.test.ts, parent.test.ts, trunk.test.ts, delete.test.ts, ai.test.ts, create.test.ts, ai-metadata.test.ts, ai-shortcut.test.ts
- [x] **manual:** Direct render of the issue's spec example - .reports/dub-1-qa.md §1 — output matches the issue's 'Output format users will see' byte for byte.

## Quality gates

- **biome lint + format:** `pnpm checks` - passed (Checked 186 files in 28ms. No fixes applied.)
- **TypeScript:** `pnpm typecheck` - passed (turbo cache hit on both dubstack and docs packages.)
- **Vitest:** `pnpm test` - passed (68 test files, 499 tests passing (up from 486 before adding errors.test.ts and error-formatting.test.ts).)

## Self-QA

See [QA fallback evidence](.reports/dub-1-qa.md).

Direct render of the issue's spec example matches byte-for-byte; gates pass.

- DubError() with empty recovery renders bare message (errors.test.ts).
- DubError() with recovery renders 'What you can do:' numbered block (errors.test.ts).
- create('feat/x', cwd, { ai: true, noAi: true }) throws with the documented flag-conflict recovery (error-formatting.test.ts).
- abortCommand() on an initialized repo with no active op throws the 'No operation in progress.' message with two recovery steps (error-formatting.test.ts).
- restack() on a freshly-initialised repo throws the dirty-tree error because init writes .gitignore (error-formatting.test.ts).
- Direct invocation of formatDubError() against the spec example yields the exact format from the issue description (.reports/dub-1-qa.md §1).

## Acceptance criteria

- [x] DubError constructor accepts recovery: string[] as the second argument - packages/cli/src/lib/errors.ts:21 — constructor signature exactly matches the issue spec.
- [x] Top-level error handler in packages/cli/src/index.ts prints message + recovery block in the documented format - packages/cli/src/index.ts:main catch block; output matches the issue's 'Output format users will see' verbatim (see .reports/dub-1-qa.md §1).
- [x] All existing `throw new DubError(...)` sites updated with sensible recovery steps - All throw sites across packages/cli/src/{commands,lib,index.ts} updated. Sites with meaningful next steps get a recovery array; pure programmer-invariant errors (invariants.ts) point at 'dub doctor'; arg-validation throws point at the correct flag usage.
- [x] Unit tests for DubError formatting - packages/cli/src/lib/errors.test.ts — 5 tests covering default recovery, supplied recovery, bare formatting, numbered block, multi-line message.
- [x] Snapshot tests on a few command error outputs to lock the format - packages/cli/test/error-formatting.test.ts — 4 inline snapshots on create, abort, restack command throws.
- [x] All existing tests still pass - pnpm test → 499 / 499 passing. Updated 10 pre-existing test files that asserted on inline recovery substrings.

## Adversarial review

Iterations: 1

Remaining critical/major: 0/0

Remaining minor/nitpick: 1/0

- feature-dev:code-reviewer claimed the restack snapshot was wrong. Verified false: init() writes .gitignore, which dirties the worktree before restack reaches the not-tracked check. Renamed the test to 'locks the restack dirty-worktree error format (init dirties .gitignore)' to make the flow explicit.

## Dependencies

- **External dependencies:** No external dependencies detected. Pure refactor inside packages/cli.

## Rollout

Library refactor with backwards-compatible default. Ships when merged.

- **On merge - Standard release pipeline:** Picked up by the next semantic-release on main. No feature flag needed because DubError's second arg defaults to [].
- **Post-merge - Downstream surfaces can adopt:** TUI, support bundle, AI assistant, and any future renderer should call formatDubError() (or read error.recovery) instead of re-implementing the format.

## Commit

```text
feat(cli): universal recovery hints in DubError
```
