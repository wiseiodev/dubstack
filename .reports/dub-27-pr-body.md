## TL;DR

Rebuilt `dub co`'s interactive picker on a custom @inquirer/core prompt. Each row now shows PR #, review status, CI rollup, and last-commit age sourced from the 30s overview cache, with branch names colored by stack region. New shortcuts: `p` opens the PR, `d` diffs against parent, `c` copies the branch name; side-effect actions re-launch the picker so users can chain them. New `--refresh` flag busts the cache; `--no-color` opts out of ANSI styling.

## Why

Picker entries previously showed only the branch name — users had to leave `dub co` to look up PR/CI status or copy a branch name.

Tier 1 already exposed `computeRegions` (DUB-77) and Tier 2 already exposed `getStackOverviewBatch` (DUB-25); this issue wires both into the picker.

### Before

- `interactiveCheckout` rendered `name + (current)` and nothing else.
- Esc was the only non-Enter key handled — no `p`/`d`/`c` shortcuts.

### After

- Rows show region-colored branch name + `#PR · review · CI · age` metadata.
- 5 shortcuts wired: Enter, p (open PR), d (git diff vs parent), c (clipboard copy, best-effort), Esc/q/Ctrl-C (cancel).
- Cache hit renders instantly; `--refresh` forces a fresh `gh pr list` round-trip.

## File-by-file

### packages/cli/src/lib/branch-picker.ts

new +236 / -0

Custom @inquirer/core prompt. Returns a tagged outcome (`checkout`/`cancel`/`pr`/`diff`/`copy`) so the caller can dispatch side-effects and re-launch the picker. Shortcuts only fire when the search input is empty so typing branch names that contain `p`/`d`/`c` keeps filtering. Includes an explicit `bounds.first === -1` guard to prevent the navigation loop from spinning when the filter narrows to only the disabled current branch.

```ts
if (
  !rl.line &&
  selected &&
  isSelectable(selected) &&
  (key.name === 'p' || key.name === 'd' || key.name === 'c')
) {
  rl.clearLine(0);
  setStatus('done');
  const type =
    key.name === 'p' ? 'pr' : key.name === 'd' ? 'diff' : 'copy';
  done({ type, branch: selected.value });
  return;
}
```

### packages/cli/src/lib/branch-picker-format.ts

new +90 / -0

Label formatting helpers. `buildBranchMetaText` renders `#101 · ✔ Approved · CI ✔ · 2h ago`; `formatBranchLabel` pads the branch column, colors the name by region, and dims the metadata. Honors `noColor` for the `--no-color` flag, `NO_COLOR=1`, and non-TTY stdout.

```ts
function regionColor(region: LogRegion): (text: string) => string {
  switch (region) {
    case 'root':
      return (t) => chalk.bold(t);
    case 'ancestor':
      return (t) => chalk.cyan(t);
    case 'sibling-subtree':
      return (t) => chalk.dim(t);
    case 'current':
    case 'descendant':
      return (t) => t;
  }
}
```

### packages/cli/src/lib/clipboard.ts

new +29 / -0

Best-effort clipboard copy. Tries `pbcopy` on darwin, `clip` on win32, `wl-copy` → `xclip` → `xsel` on linux. Never throws — returns the tool name on success or `null` so the caller can print `(copy unavailable)`.

```ts
for (const { cmd, args } of candidates) {
  try {
    await execa(cmd, args, { input: text });
    return cmd;
  } catch {
    // Try the next candidate.
  }
}
return null;
```

### packages/cli/src/commands/checkout.ts

mod +250 / -53

`interactiveCheckout` rewritten around the new picker. Loops on side-effect outcomes (re-rendering the picker after `p`/`d`/`c`), exits on `checkout`/`cancel`. Adds `computeAllRegions` (merges per-stack `computeRegions` with a rank function so the same root branch in multiple stacks picks the most specific region) and `buildBranchChoices` (split out so tests can exercise it without the prompt). Overview fetch is wrapped in `safeOverview` so a `gh` failure degrades to no metadata instead of erroring the picker.

```ts
while (true) {
  const choices = buildBranchChoices({
    validBranches, currentBranch, regions, overview, noColor,
  });
  const outcome = await branchPickerPrompt({
    message: 'Checkout a branch (autocomplete or arrow keys)',
    choices, defaultBranch,
    footer: footerParts.join('\n') || undefined,
  });
  const next = await handlePickerOutcome(outcome, state, cwd);
  if ('done' in next) return next.done;
  defaultBranch = next.continueWith;
}
```

### packages/cli/src/index.ts

mod +9 / -0

Adds `--refresh` and `--no-color` options to the `checkout`/`co` command and threads them into `interactiveCheckout`.

```ts
.option('--refresh', 'Bypass the 30s PR/CI overview cache and refetch from GitHub')
.option('--no-color', 'Disable ANSI colors in the picker')
```

### packages/cli/src/lib/branch-picker.test.ts

new +169 / -0

11 tests against `@inquirer/testing`'s `render()` harness — Enter checkout, fuzzy filter, `p`/`d`/`c`/Esc dispatch, the 'typing into search input shadows shortcuts' guard, footer rendering, empty-match state, and a regression test for the disabled-only-row navigation guard.

```ts
it('treats `p` typed into search input as text, not a shortcut', async () => {
  // Typing characters that would otherwise be shortcuts must filter the
  // list (e.g. `feat/auth-signup` contains `p`) instead of opening a PR.
  events.type('signup');
  events.keypress({ name: 'return' });
  await expect(answer).resolves.toEqual({
    type: 'checkout', branch: 'feat/auth-signup',
  });
});
```

### packages/cli/src/lib/branch-picker-format.test.ts

new +139 / -0

8 tests for the label formatter — PR + draft + CI + age, APPROVED+SUCCESS, MERGED lifecycle fallback, age-only when no PR, and `noColor` plain-text mode.

### packages/cli/src/lib/clipboard.test.ts

new +70 / -0

5 tests for the clipboard helper. Mocks `execa` and asserts platform-specific candidate order, fallthrough on ENOENT, and that it never throws even when every candidate rejects.

### packages/cli/src/commands/checkout.test.ts

mod +119 / -0

Adds tests for `computeAllRegions` (current/ancestor/sibling-subtree classification) and `buildBranchChoices` (current-branch disabling, fuzzy-search key, PR metadata rendering, plain-name fallback).

### apps/docs/content/docs/commands/checkout.mdx

mod +50 / -2

Documents the new picker — sample rendered rows, region-color table, shortcut table, `--refresh` and `--no-color` flags, and the `(copy unavailable)` fallback behavior.

### packages/cli/package.json

mod +2 / -0

Adds `@inquirer/core` as a direct dependency (custom prompt needs `createPrompt`, hooks, and `usePagination`) and `@inquirer/testing` as a dev dependency for the prompt-interaction tests.

### pnpm-lock.yaml

mod +92 / -22

Lockfile update for `@inquirer/core` and `@inquirer/testing`.

## Where to focus review

1. **Search input shadows shortcuts** - `packages/cli/src/lib/branch-picker.ts:164`: `p`/`d`/`c` only fire when `rl.line` is empty. Verify the test at branch-picker.test.ts:93 that types 'signup' and presses Enter still checks out `feat/auth-signup` rather than dispatching a `pr` action on the `p`.
2. **Disabled-only-row navigation guard** - `packages/cli/src/lib/branch-picker.ts:148`: When the filter narrows to only the disabled current row, `bounds.first === -1`. Without the early-return guard, arrow keys spin forever. The regression test at branch-picker.test.ts:155 types `main` and presses up/down to cover this.
3. **Region merging across stacks** - `packages/cli/src/commands/checkout.ts:113`: When the same root branch appears in multiple stacks (e.g. `main`), `computeAllRegions` keeps the most specific region via `regionRank`. Confirm `current`/`ancestor` win over `root` so the current branch isn't accidentally re-tagged as `root`.
4. **Overview fetch failure is non-fatal** - `packages/cli/src/commands/checkout.ts:199`: `safeOverview` swallows errors and prints a yellow `PR metadata unavailable: …` line so the picker still works with just branch names + region styling when `gh` is misconfigured.

## Test plan

- [x] **unit:** branch-picker prompt — 11 tests via @inquirer/testing - pnpm test src/lib/branch-picker.test.ts → 11 passed
- [x] **unit:** branch-picker-format — 8 tests for meta + region styling - pnpm test src/lib/branch-picker-format.test.ts → 8 passed
- [x] **unit:** clipboard — 5 tests for platform candidate order + silent failure - pnpm test src/lib/clipboard.test.ts → 5 passed
- [x] **unit:** checkout — computeAllRegions + buildBranchChoices coverage - pnpm test src/commands/checkout.test.ts → 17 passed (+5 new)
- [x] **manual:** `dub co --help` smoke - pnpm cli:dev co --help shows --refresh and --no-color flags wired correctly

## Quality gates

- **biome:** `pnpm checks` - passed (Checked 281 files in 56ms. No fixes applied.)
- **typecheck:** `pnpm typecheck` - passed (tsc --noEmit clean across the monorepo (turbo cache hit after first run).)
- **tests:** `pnpm test` - passed (93 test files / 859 tests passing (was 90/830 pre-change).)
- **evals:** `pnpm evals` - skipped (AGENTS.md only requires evals when AI metadata or prompts change. This change touches neither.)

## Self-QA

See [QA fallback evidence](.reports/dub-27-qa.md).

Self-QA via @inquirer/testing harness (simulates real TTY keypresses) plus full local gate.

- Enter checks out the highlighted branch
- Fuzzy filter narrows the list and Enter checks out the match
- p / d / c dispatch correctly on the highlighted branch when the search input is empty
- Typing a branch substring that contains `p` filters instead of opening a PR
- Esc / q / Ctrl-C cancels without switching branches
- Arrow keys do not spin when the filter narrows to only the disabled current row

## Acceptance criteria

- [x] Picker entries show PR/CI/age metadata from getStackOverviewBatch when available - branch-picker-format.ts:33 + checkout.ts:182; tests at branch-picker-format.test.ts:24, checkout.test.ts:226.
- [x] Region styling applied via computeRegions (or promoted helper) - checkout.ts:113 `computeAllRegions` re-uses `computeRegions` from commands/log.ts and merges across stacks; tests at checkout.test.ts:148.
- [x] Cached data renders instantly; --refresh forces fresh fetch - `getStackOverviewBatch({ refresh })` already implements the 30s TTL; CLI wired at index.ts:1078; smoke-tested via `dub co --help`.
- [x] All 5 shortcuts (ENTER, p, d, c, Esc) work - branch-picker.test.ts cases at lines 27, 54, 67, 80, 108.
- [x] Clipboard copy fails silently when no clipboard tool exists; prints '(copy unavailable)' instead of erroring - clipboard.ts returns null on total failure; checkout.ts:282 prints `(copy unavailable)`; clipboard.test.ts:58 asserts no-throw.
- [x] Tests for fuzzy match, shortcut dispatch, region rendering, cancellation - 29 new tests across 4 files cover all four areas.
- [x] Docs at apps/docs/content/docs/commands/checkout.mdx - Rewritten with picker sample, region table, shortcut table, --refresh/--no-color flags.

## Adversarial review

Iterations: 1

Remaining critical/major: 0/0

Remaining minor/nitpick: 0/0

- Reviewer flagged an infinite-loop risk in arrow-key navigation when the filter narrowed to only the disabled current row → fixed via explicit `bounds.first === -1` guard (branch-picker.ts:148) and regression test (branch-picker.test.ts:155).
- Reviewer flagged that `rl.write(searchTerm)` on Enter with no selectable row doubled the visible text → fixed by making that path a no-op.
- Reviewer flagged that `disabled?: false | string` allowed a misleading explicit `false` → narrowed type to `disabled?: string` and updated caller to use `undefined`.

## Dependencies

- **DUB-25 (batched PR/CI overview):** Done — consumed via `getStackOverviewBatch`.
- **DUB-77 (tree-aware log regions):** Done — `computeRegions` imported from commands/log.ts.

## Rollout

Drop-in enhancement to the existing `dub co` interactive picker. No state schema change, no migration, no flag gating — opt-in only when the user already invokes `dub co` without a branch argument.

- **On merge - Pipeline build:** Release pipeline builds dubstack@<next> with the new picker.
- **Post-release smoke - Run `dub co` in a stacked repo:** Verify PR/CI/age rows render and `p`/`d`/`c` work end-to-end against a real `gh` install.

## Commit

```text
feat(checkout): interactive picker w/ PR metadata + p/d/c shortcuts [DUB-27]
```
