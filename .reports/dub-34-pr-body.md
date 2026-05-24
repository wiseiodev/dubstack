## TL;DR

New `dub pop` command soft-resets N commits off the current branch and leaves their changes squashed in the index. Refuses dirty trees and parent-boundary overrun. `dub undo` reverses the pop. Descendants restack lazily on the next `dub modify`.

## Why

Graphite's most-cited UX complaint: `gt modify` doesn't pop commits into the staging area.

Users today fall back to `git reset --soft; commit; gt submit`, which bypasses stack metadata.

### Before

- No first-class way to edit a commit you just landed without manual rebase or amend gymnastics.
- Editing a middle-of-stack commit required interactive rebase or `git reset --soft` + manual descendant handling.

### After

- `dub pop` soft-resets N commits into staged changes with safety checks (dirty tree, parent boundary).
- `dub modify -ac -m '…'` after a pop produces a new commit and auto-restacks descendants lazily.
- `dub undo` rolls the pop back when called from the original branch.

## File-by-file

### packages/cli/src/commands/pop.ts

new +97 / -0

Command entrypoint. Validates steps, refuses dirty trees, computes commits-ahead via `git rev-list --count`, then `git reset --soft HEAD~N`. Writes an undo entry pinning the pre-pop branch tip.

```ts
if (steps > branchCommitCount) {
  throw new DubError(
    `Cannot pop ${steps} commit(s): '${branch}' has only ${branchCommitCount} commit(s) above '${parent}'.`,
    [...],
  );
}
```

### packages/cli/src/commands/undo.ts

mod +32 / -1

Extends undo to handle `pop`: refuses if user switched branches after the pop, allows untracked files (git hard-reset preserves them), then resets the branch to the pre-pop tip.

```ts
if (entry.operation === 'pop') {
  const [branch, sha] = Object.entries(entry.branchTips)[0] ?? [];
  if (current !== branch) {
    throw new DubError(
      `Cannot undo pop: currently on '${current}', expected '${branch}'.`,
      [`Run 'dub co ${branch}' to switch back, then rerun 'dub undo'.`],
    );
  }
  ...
}
```

### packages/cli/src/lib/git.ts

mod +66 / -0

Adds three helpers: `countCommitsAhead`, `softResetHead`, and `hasUnstagedTrackedChanges` (ignores untracked files because `git reset --hard` preserves them).

```ts
export async function hasUnstagedTrackedChanges(cwd: string): Promise<boolean> {
  const { stdout } = await execa(
    'git',
    ['status', '--porcelain', '--untracked-files=no'],
    { cwd },
  );
  for (const line of stdout.split('\n')) {
    if (line.length < 2) continue;
    if (line[1] !== ' ') return true;
  }
  return false;
}
```

### packages/cli/src/lib/undo-log.ts

mod +2 / -2

Adds `'pop'` to the `operation` union and updates the user-facing 'nothing to undo' hint.

```ts
operation: 'create' | 'restack' | 'pop';
```

### packages/cli/src/index.ts

mod +36 / -1

Wires `dub pop` into commander. Reuses `parsePositiveInt` for `--steps`.

```ts
program
  .command('pop')
  .description('Pop the last commit(s) off the current branch into the staging area')
  .option('-n, --steps <count>', 'Number of commits to pop (default: 1)', parsePositiveInt)
```

### packages/cli/src/commands/pop.test.ts

new +162 / -0

Unit tests: pop 1, pop N squash, parent-boundary refusal, dirty-tree refusal, invalid steps, undo-entry round-trip, untracked-parent refusal, undo restore, undo guards (off-branch, tracked edits, untracked files).

### packages/cli/test/commands/pop-flow.test.ts

new +76 / -0

Cross-command scenario: pop on a middle branch, edit, `modify -ac` — descendants restack lazily onto the rewritten parent.

### apps/docs/content/docs/commands/pop.mdx

new +42 / -0

User-facing docs page: usage, flag table, safety contract, common pattern.

### apps/docs/content/docs/commands/meta.json

mod +1 / -0

Registers `pop` in the docs sidebar (positioned right after `modify`).

## Where to focus review

1. **Pop-undo branch guard** - `packages/cli/src/commands/undo.ts:38-69`: Refuses to undo if the user switched off the popped branch — staged changes on a different branch would block checkout. Confirm the message is clear and the guard order (branch check before dirty check) is correct.
2. **hasUnstagedTrackedChanges semantics** - `packages/cli/src/lib/git.ts:638-657`: Intentionally ignores untracked files because `git reset --hard` doesn't touch them. Verify the porcelain column check (`line[1] !== ' '`) catches every modified-tracked case.
3. **Parent-boundary count via rev-list** - `packages/cli/src/commands/pop.ts:67-78`: Uses `git rev-list --count parent..branch`. For linear stacks this matches the branch-local commit count; merge commits in a branch (rare in stacks) would be counted as one commit each, which is the intent.

## Test plan

- [x] **unit:** pop command behaviors (11 cases) - packages/cli/src/commands/pop.test.ts — covers happy path, squash, refusal modes, undo guards.
- [x] **integration:** pop + modify lazy restack of descendants - packages/cli/test/commands/pop-flow.test.ts — pops a middle branch, recommits, asserts child rebases onto the new parent tip.
- [x] **manual:** End-to-end CLI dry run - Built CLI in tmpdir, ran pop --steps 2, observed staged a.txt + b.txt and empty log; ran dub undo, observed two commits restored and clean index.
- [x] **build:** tsup build of dubstack CLI - `pnpm --filter dubstack build` succeeded; bundle 426 KB.

## Quality gates

- **tests:** `pnpm test` - passed (90 test files, 817 tests passed.)
- **typecheck:** `pnpm typecheck` - passed (Both `dubstack` and `docs` packages typecheck cleanly.)
- **biome:** `pnpm checks` - passed (Checked 270 files; no errors.)
- **AI evals:** `pnpm evals` - skipped (No AI metadata/prompts changed in this PR, and the eval suite requires Gemini/Gateway/Bedrock provider keys not present in this workspace.)

## Self-QA

See [QA fallback evidence](.reports/dub-34-qa.md).

Deterministic shell-output evidence + 12 vitest cases replace the video.

- dub pop soft-resets one commit and leaves changes staged
- dub pop --steps N squashes N commits into the staging area
- dub pop refuses to cross the parent boundary
- dub pop refuses on a dirty working tree
- dub undo after pop restores the popped commits
- dub undo refuses when user switched off the popped branch
- dub modify after pop restacks descendants lazily

## Acceptance criteria

- [x] New packages/cli/src/commands/pop.ts - Created with full command implementation.
- [x] --steps N flag works - Wired via commander `parsePositiveInt`; tested with --steps 3 squashing three commits.
- [x] Safety checks for dirty tree and parent boundary - `isWorkingTreeClean` guard and `countCommitsAhead` parent-boundary refusal; both covered by tests.
- [x] Undo log entry created - Saves an entry with operation='pop' and the pre-pop branch tip; `dub undo` reverses via hard-reset.
- [x] Restack happens lazily on next modify - pop.ts doesn't trigger restack; existing modify.ts auto-restacks after commit/amend. Cross-command test verifies descendant rebase.
- [x] Tests for all paths - 12 vitest cases across pop.test.ts and pop-flow.test.ts.
- [x] Docs at apps/docs/content/docs/commands/pop.mdx - Created with usage, flags, safety, common pattern; registered in meta.json.

## Adversarial review

Iterations: 1

Remaining critical/major: 0/0

Remaining minor/nitpick: 1/0

- Initial review flagged two critical issues: (1) pop-undo didn't guard against the user switching off the popped branch, and (2) hasUnstagedChanges treated untracked files as blocking even though `git reset --hard` preserves them. Both fixed: added explicit current-branch guard and renamed/reworked the helper to `hasUnstagedTrackedChanges` (porcelain --untracked-files=no). Tests updated to cover the new guards. Reviewer also noted dead code in the original helper which is gone after the rewrite.
- Remaining minor: parent-boundary check uses rev-list --count, which counts merge commits as 1; this matches intent for linear stacks and is documented behavior.

## Dependencies

- **External dependencies:** No external dependencies detected. Issue is marked 'Blocked by: None — can start immediately'.

## Rollout

Ships as a new CLI command in the next dubstack release. Zero migration; opt-in usage.

- **On merge - Release pipeline picks up new command:** Next dubstack publish includes `dub pop` and its docs page. No state-schema migration required (undo entries gain a new operation tag handled by extended union).
- **First user run - Users discover via help:** `dub pop --help` shows usage + examples; docs site shows the new sidebar entry under Commands.

## Commit

```text
feat(pop): pop last commit(s) into staged changes [DUB-34]
```
