# Self-QA fallback - DUB-83

> This work item has no useful browser recording surface, so this file replaces
> the video and records deterministic proof instead.

## Why no video

DUB-83 ships infrastructure-only changes: a new lib (`lib/checkout-history.ts`)
and wiring of `appendCheckoutHistory` after `checkoutBranch` calls in six
command files. There is no new user-facing output, no UI surface, and no
demo path that produces a meaningful screen recording — the only observable
effect is a JSON file appearing under `.git/dubstack/`. Verification is
deterministic via unit tests and full-suite regression.

## What was verified

1. **lib/checkout-history.ts API matches the spec** — exports
   `appendCheckoutHistory`, `readCheckoutHistory`, `clearCheckoutHistory`
   with the signatures from the issue. `CheckoutEntry` shape is
   `{ branch, at, via }`.
2. **Ring buffer at `maxSize = 20`** — `appendCheckoutHistory` keeps only
   the newest 20 entries. Verified by the "enforces a ring buffer of size 20"
   test: 25 inserts, read returns 20 newest, oldest is `branch-5`, newest
   is `branch-24`.
3. **Atomic write-rename** — temp file pattern
   `checkout-history.json.<pid>.<ts>.tmp` is renamed onto the target.
   On rename failure the temp is unlinked. Verified by the "writes
   atomically and leaves no temp files behind" test.
4. **Transient filter** — entries written with `transient: true` are dropped
   from the default read. Verified by two tests (interleaved and "all
   transient before one visible"). Transient entries still consume ring
   slots so the buffer behaves predictably under heavy internal traffic.
5. **All HEAD-changing commands wired** — `appendCheckoutHistory` is called
   after every `checkoutBranch` in the issue's scope:
   - `commands/checkout.ts` → `via: 'checkout'` (covers `dub co`,
     `dub checkout`, and `dub checkout --trunk` since they all funnel
     through `checkout()`)
   - `commands/navigate.ts` → `via: 'up' | 'down' | 'top' | 'bottom'`
   - `commands/create.ts` → `via: 'create'` (also covers `dub flow` since
     it composes `create`)
   - `commands/post-merge.ts` → `via: 'post-merge', transient: true` (3 sites)
   - `commands/restack.ts` → `via: 'restack', transient: true`
   - `commands/sync.ts` → `via: 'sync', transient: true` (4 sites)
   - `commands/stack-maintenance.ts` `submitRefreshedStacks` → `via:
     'submit-refresh', transient: true` (called from both post-merge and
     sync during PR refresh; caught during adversarial review)
6. **`appendCheckoutHistory` is best-effort** — internal try/catch swallows
   I/O errors so a transient disk problem cannot break a checkout that
   already succeeded. Adopted after the initial draft caused sync tests
   to fail when mock cwds couldn't resolve a git root: the lib's throw
   was swallowed by sync's own try/catch and masqueraded as a checkout
   failure. Best-effort semantics fit the "auxiliary log" role.
7. **No regression in existing tests** — full CLI suite is green:
   `Test Files 98 passed (98) / Tests 924 passed (924)`. The new file
   adds 10 tests (`src/lib/checkout-history.test.ts`).
8. **Repo gates green** — `pnpm checks`, `pnpm typecheck`, and
   `pnpm test` all pass cleanly.

## Evidence

- Unit tests for the new lib:
  ```
  $ pnpm vitest run checkout-history
   ✓ src/lib/checkout-history.test.ts (10 tests) 822ms
   Test Files  1 passed (1)
        Tests  10 passed (10)
  ```
- Full CLI suite after wiring all commands:
  ```
  $ pnpm vitest run
   Test Files  98 passed (98)
        Tests  924 passed (924)
  ```
- Typecheck and lint:
  ```
  $ pnpm typecheck
   Tasks:  2 successful, 2 total
  $ pnpm checks
   $ biome check .
   Checked 301 files in 957ms. No fixes applied.
  ```
- Call-site inventory (every `checkoutBranch` outside lib helpers,
  `undo.ts`, and `delete.ts` is wired — `undo`/`delete` are explicitly
  out of scope per the issue spec, which enumerates only the seven
  user-initiated commands and four internal-restore commands above):
  ```
  $ grep -rn 'appendCheckoutHistory' packages/cli/src/commands/
  checkout.ts:84            via: 'checkout'
  create.ts:240             via: 'create'
  navigate.ts:88,143,176,239 via: 'up'|'down'|'top'|'bottom'
  post-merge.ts:180,208,230 via: 'post-merge', transient: true
  restack.ts:267            via: 'restack', transient: true
  stack-maintenance.ts:106  via: 'submit-refresh', transient: true
  sync.ts:448,1029,1090,1106 via: 'sync', transient: true
  ```

## Follow-up flag

None blocking. `dub undo` and `dub delete` change HEAD but were intentionally
left unwired because the issue spec does not list them; `dub back` (DUB-38)
can decide whether to treat undo restores as a back-navigable target when
it lands. The lockfile integration noted in step 5 of the issue is gated
on DUB-60 and is explicitly future work.
