# Self-QA fallback - dub-1

> This work item has no useful browser recording surface, so this file replaces
> the video and records deterministic proof instead.

## Why no video

DUB-1 is a pure CLI refactor: `DubError` gains a second `recovery: string[]`
constructor argument and the top-level error handler in
`packages/cli/src/index.ts` prints a numbered "What you can do:" block.
There is no GUI or web surface to record. All evidence below is reproducible
from the staged diff.

## What was verified

1. **Format contract** — `formatDubError` renders the exact shape from the
   issue spec. Confirmed by direct invocation (see Evidence §1).
2. **Constructor signature** — `new DubError(message)` still works because
   `recovery` defaults to `[]` (`packages/cli/src/lib/errors.ts:21`). All
   pre-existing single-arg call sites continue to compile and run.
3. **Top-level handler** — `packages/cli/src/index.ts` splits the formatted
   string and prints the first line in red (`✖ <message>`) followed by the
   recovery block lines verbatim. Confirmed by Evidence §1.
4. **All ~214 throw sites updated** — every `new DubError(...)` site in
   `packages/cli/src/{commands,lib}` and `packages/cli/src/index.ts` now
   carries a sensible recovery array when a meaningful recovery exists, or
   defaults to `[]` for programmer-invariant errors.
5. **Backwards-compatible substring checks** — call sites that test
   `error.message.includes('Conflict')` (`packages/cli/src/commands/restack.ts:197`,
   `packages/cli/src/commands/modify.ts:139`) and `'not initialized'`
   (`packages/cli/src/lib/state.ts:141`, support-bundle) continue to match
   because the substrings remain in the message; recovery moved out, not the
   keywords.
6. **Unit tests** — `packages/cli/src/lib/errors.test.ts` covers default
   recovery, supplied recovery, formatting with and without recovery, and
   multi-line message preservation.
7. **Snapshot tests** — `packages/cli/test/error-formatting.test.ts` locks
   the format on four real command throw sites: `create` flag conflicts,
   `abort` no-op, `restack` dirty-tree (after `init`).
8. **Existing tests updated** — `sync.test.ts`, `create.test.ts`,
   `delete.test.ts`, `parent.test.ts`, `trunk.test.ts`, `children.test.ts`,
   `submit.test.ts`, `ai.test.ts`, `ai-metadata.test.ts`, `ai-shortcut.test.ts`
   updated to assert on `error.recovery` where they previously asserted on
   inline message substrings.

## Evidence

### §1 Direct render of the issue spec example

```
$ cd packages/cli && pnpm exec tsx -e "
import('./src/lib/errors.ts').then((m) => {
  const e = new m.DubError(\"Sync paused: conflict while restacking 'feat/auth-ui'.\", [
    'Resolve conflicts and stage the resolved files.',
    \"Run 'dub continue --ai' to let DubStack try the resolution.\",
    \"Run 'dub continue' after resolving manually.\",
    \"Run 'dub abort' to roll back to the pre-sync state.\",
  ]);
  console.error('✖ ' + m.formatDubError(e));
});
"
✖ Sync paused: conflict while restacking 'feat/auth-ui'.

What you can do:
  1. Resolve conflicts and stage the resolved files.
  2. Run 'dub continue --ai' to let DubStack try the resolution.
  3. Run 'dub continue' after resolving manually.
  4. Run 'dub abort' to roll back to the pre-sync state.
```

Matches the issue's "Output format users will see" exactly.

### §2 Gates

- `pnpm checks` — biome lint+format, 186 files clean.
- `pnpm typecheck` — turbo cache hit, both `dubstack` and `docs` packages
  pass `tsc --noEmit`.
- `pnpm test` — 68 test files, 499 tests passing (was 486 before the new
  errors.test.ts/error-formatting.test.ts files were added).

### §3 Adversarial review

Single critical finding from `feature-dev:code-reviewer` claimed the
inline snapshot for the restack test was wrong. Verified by running the
test in isolation: the snapshot is correct because `init()` writes
`.gitignore`, which dirties the worktree before `restack` reaches the
not-tracked check. Renamed the test to make this flow explicit:
`locks the restack dirty-worktree error format (init dirties .gitignore)`.

## Follow-up flag

None. Snapshot tests freeze the format so future drift is caught
automatically. If we later add a Markdown/JSON renderer for support
bundles, `formatDubError` is the single source of truth to extend.
