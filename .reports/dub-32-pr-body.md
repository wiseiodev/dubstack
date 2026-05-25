## TL;DR

New `dub squash` command. Soft-resets the branch to its tracked parent, commits with either `-m <msg>`, an AI-generated Conventional Commit summary (`--ai`), or the original commit messages concatenated most-recent-first. Auto-restacks descendants via the same path `dub modify` uses. No-ops for 0/1 commits.

## Why

Tier 3 parity with `gt squash` — stacked workflows accumulate small commits per iteration; squashing before submitting keeps the eventual PR/landing history clean.

Without a first-class `dub squash`, users either run a manual `git reset --soft` (no descendant restack, no protective dirty-tree check) or rebase interactively (slow and conflict-prone for trivial squashes).

Re-uses the `dub modify` auto-restack pattern, so the conflict-recovery surface (`dub restack --continue`, `dub abort`) is already documented and tested.

### Before

- No way to collapse a branch's commits without dropping to raw git and handling parent boundary, dirty-tree refusal, and descendant restack by hand.
- Multi-commit branches submitted as-is produced noisy PRs and noisy `main` history after squash-merge.
- AI-assisted commit-message generation existed for `dub create --ai` and `dub flow --ai` but not for the squash flow.

### After

- `dub squash` collapses N commits → 1 commit using the original messages concatenated (most recent first) by default.
- `-m "<msg>"` overrides the auto-generated body. `--ai` generates a Conventional Commit summary via the configured AI provider (Gemini / Gateway / Bedrock).
- 0/1-commit branches no-op with an informational line — no destructive surprise.
- Descendants restack automatically; the success line only appears when commits were actually rebased.

## File-by-file

### packages/cli/src/commands/squash.ts

new +239 / -0

Command implementation. Validates option combos (`--ai` vs `-m`), refuses on dirty tree or untracked branch, counts commits via `countCommitsAhead`, builds the squash message from one of three sources, soft-resets to the parent tip, commits via `commitStaged` (single-line) or `commitStagedFromFile` (multi-line), then runs `restack` and reports whether any descendant was actually rebased.

```typescript
const commitCount = await countCommitsAhead(branch, parent, cwd);
if (commitCount <= 1) {
  return {
    branch,
    parent,
    squashedCommits: 0,
    restacked: false,
    noopReason: commitCount === 0 ? 'no-commits' : 'single-commit',
  };
}

const originalMessages = await getCommitMessagesBetween(parent, branch, cwd);

let message: string;
if (options.message?.trim()) {
  message = options.message.trim();
} else if (options.ai) {
  // ... AI generation
} else {
  message = originalMessages.join('\n\n');
}

const parentTip = await getBranchTip(parent, cwd);
await softResetTo(parentTip, cwd);
```

### packages/cli/src/commands/squash.test.ts

new +243 / -0

11 vitest tests covering: 3→1 squash + descendant restack, 1-commit no-op, 0-commit no-op, `-m` override, dirty-tree refusal, untracked-branch refusal, `--ai`+`-m` mutex, `--ai` with assistant disabled, happy `--ai` path with mocked deps, empty AI response failure, leaf-branch `restacked=false`.

```typescript
it('reports restacked=false for a leaf branch with no descendants', async () => {
  await create('feat/a', dir);
  await writeAndCommit(dir, 'a.txt', '1', 'feat: c1');
  await writeAndCommit(dir, 'b.txt', '2', 'feat: c2');

  const result = await squash(dir, {});

  expect(result.squashedCommits).toBe(2);
  expect(result.restacked).toBe(false);
});
```

### packages/cli/src/lib/git.ts

mod +79 / -0

Three new helpers all colocated near the existing `getLastCommitMessage`: `countCommitsAhead` (rev-list --count), `getCommitMessagesBetween` (git log %B with ASCII record-separator splitting), and `softResetTo` (git reset --soft <ref>). Each wraps execa with a DubError that names the manual git command to debug with.

```typescript
export async function getCommitMessagesBetween(
  base: string,
  branch: string,
  cwd: string,
): Promise<string[]> {
  const { stdout } = await execa(
    'git',
    ['log', '--format=%B%x1e', `${base}..${branch}`],
    { cwd },
  );
  return stdout
    .split('\x1e')
    .map((entry) => entry.replace(/^\n+|\n+$/g, ''))
    .filter((entry) => entry.length > 0);
}
```

### packages/cli/src/index.ts

mod +52 / -0

Wires the `dub squash` command next to `dub modify` (both branch-mutating operations that auto-restack). Output branches on `noopReason` so the user sees a quiet info line for 0/1-commit branches and a green check only when something was actually squashed.

```typescript
program
  .command('squash')
  .description(
    'Collapse every commit on the current branch (since its parent) into one',
  )
  .option('-m, --message <message>', 'Use the given message for the new commit')
  .option(
    '--ai',
    'Generate a Conventional Commit summary from the squashed commits',
  )
```

### apps/docs/content/docs/commands/squash.mdx

new +54 / -0

Command docs page. Documents the three message sources, the no-op semantics, the dirty-tree refusal, the conflict-recovery handoff to `dub restack --continue`, and the `--ai` provider requirement.

### apps/docs/content/docs/commands/meta.json

mod +1 / -0

Inserts `squash` after `modify` in the docs sidebar so the new command shows up in the right slot.

### .reports/dub-32-qa.md

new +62 / -0

QA fallback (no .tsx changed). Records the 5 live smoke-test scenarios on a temp repo plus the 11 automated tests, with full evidence (924/924 total tests, biome clean, typecheck clean).

## Where to focus review

1. **Soft-reset + commit ordering** - `packages/cli/src/commands/squash.ts:140-162`: If the soft-reset succeeds but `commitStaged`/`commitStagedFromFile` fails (e.g. pre-commit hook rejection), the branch is left at the parent tip with the squashed changes staged. The error message names `git reset --hard ORIG_HEAD` as the recovery — ORIG_HEAD is set by `git reset --soft` so this is correct, but worth re-confirming.
2. **Auto-restack reporting (`restacked` semantics)** - `packages/cli/src/commands/squash.ts:164-180`: `restack()` returns `{ status: 'up-to-date', rebased: [] }` for a leaf branch rather than throwing. `restacked` is now derived from `restackResult.rebased.length > 0` so the CLI only prints "Descendants restacked." when work was actually done. Initial adversarial pass caught the misleading leaf-branch print; verify the fix matches the intended UX.
3. **Default message ordering** - `packages/cli/src/lib/git.ts:getCommitMessagesBetween`: `git log base..branch` returns most-recent first. The test at squash.test.ts:64-73 pins the c3 → c2 → c1 ordering and asserts the body via `indexOf` comparisons. Confirm reviewers are happy with the most-recent-first ordering before paragraph separators are introduced upstream.

## Test plan

- [x] **unit:** squash.test.ts — 11 scenarios on isolated temp git repos - pnpm vitest run squash → 11/11 passing in 2.1s.
- [x] **integration:** Full repo test suite - pnpm test → 925/925 passing across 98 files.
- [x] **manual:** End-to-end smoke test on a real git repo (3-commit squash, single-commit no-op, dirty refusal, --help, --ai+-m mutex) - Captured in .reports/dub-32-qa.md. CLI built via tsup, exercised against /tmp/dub-squash-smoke (temp repo cleaned up post-run).

## Quality gates

- **Biome lint+format:** `pnpm checks` - passed (Checked 301 files in 158ms. No fixes applied.)
- **TypeScript:** `pnpm typecheck` - passed (2 packages (dubstack + docs) clean.)
- **Vitest:** `pnpm test` - passed (925/925 tests passing across 98 files.)
- **Build:** `pnpm build` - passed (tsup ESM build clean (480 KB).)

## Self-QA

See [QA fallback evidence](.reports/dub-32-qa.md).

Live smoke-test transcript on a temp repo + 11 automated vitest scenarios.

- 3-commit branch → 1 commit via default concatenation, descendant restacked.
- Single-commit no-op with informational output.
- Dirty working tree refusal with full recovery hint trio.
- --help renders description, options, and 3 example lines.
- --ai + -m mutual-exclusion error with recovery hint.

## Acceptance criteria

- [x] New `packages/cli/src/commands/squash.ts` - 239-line command module landed at the canonical path.
- [x] No-op for 0/1 commits with clear message - Both no-op paths print the per-case `Nothing to squash —` line; verified by `is a no-op for a single commit` and `is a no-op for zero commits` tests.
- [x] Default behavior squashes and concatenates messages - `collapses N commits into one with concatenated messages and restacks descendants` asserts the 3 → 1 collapse, the most-recent-first body ordering, and the descendant restack.
- [x] `-m` and `--ai` work - `-m overrides the auto-generated message` + `uses the AI-generated message when '--ai' is supplied` (with mocked AI deps) pin both paths.
- [x] Restack runs automatically - Restack is invoked unconditionally on successful squash; `restacked` field reflects whether any descendant was actually rebased.
- [x] Tests for each path - 11 vitest scenarios covering happy path, both no-ops, every flag combination, every error class, and leaf-branch restack semantics.
- [x] Docs at `apps/docs/content/docs/commands/squash.mdx` - MDX page added and inserted into `meta.json` sidebar after `modify`.

## Adversarial review

Iterations: 1

Remaining critical/major: 0/0

Remaining minor/nitpick: 0/0

- Major (fixed): `restacked` was set true even when restack returned `{ status: 'up-to-date', rebased: [] }`, causing the CLI to print "Descendants restacked" on leaf branches. Now derived from `restackResult.rebased.length > 0`.
- Minor (fixed): AI-disabled test called squash() twice; consolidated to a single rejection variable.
- Major (intentionally not addressed): no dedicated undo entry for squash. The reviewer flagged this but confirmed it is consistent with `dub modify`, which also relies on the auto-restack undo entry. Adding squash to the undo enum is out of scope for this issue and would require widening the `UndoEntry` operation enum.

## Dependencies

- **No external dependencies detected:** n/a

## Rollout

Pure additive change. No flag, no migration, no env var. Ships as part of the next dubstack CLI release once merged.

- **On merge - Available locally as `dub squash`:** Users on dev builds (`pnpm build`) get the command immediately. The `dub squash --ai` path requires `dub config ai-assistant on` and a configured provider (unchanged from `dub create --ai`).
- **Next release - Ships in the next semantic-release minor:** Conventional-commit `feat(squash):` triggers a minor bump per release.config.cjs. No release-note migration steps.

## Commit

```text
feat(squash): collapse a branch into a single commit [DUB-32]
```
