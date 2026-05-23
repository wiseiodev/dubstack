# Self-QA fallback - dub-4

> This work item has no useful browser recording surface, so this file replaces
> the video and records deterministic proof instead.

## Why no video

Pure backend change to a CLI tool (`packages/cli/src/lib/git.ts` and
`packages/cli/src/commands/sync.ts`). No browser, no TSX, no UI surface.
Behavior is verified end-to-end with real `git` processes inside isolated
test repositories.

## What was verified

All four acceptance-criteria behaviors are covered by passing tests:

1. **Namespaced fetch refs + flag set** — `fetchBranches` runs
   `git fetch --no-write-fetch-head --no-tags -f origin <branch>:refs/dubstack/fetch-head/<branch>`.
   Verified by `src/lib/git.test.ts` "writes fetched tip to
   refs/dubstack/fetch-head/<branch>", which pushes a new commit to a bare
   remote, fetches via `fetchBranches`, and asserts the namespaced ref
   matches the remote tip.
2. **`git remote prune <remote>` before trunk pull** — `sync.ts` calls
   `pruneRemote('origin', cwd)` between fetch and the trunk fast-forward
   loop. Verified by `src/commands/sync.test.ts` "clears stale namespaced
   fetch refs and prunes remote once before trunk pull", which records call
   order and asserts `prune` runs before `ff:main`. Real behavior of the
   helper is covered by `src/lib/git.test.ts` "pruneRemote".
3. **Stale `refs/dubstack/fetch-head/*` cleared at sync start** —
   `clearStaleNamespacedFetchRefs` walks the namespace and deletes any ref
   whose source branch is not in the keep set. Verified by
   `src/lib/git.test.ts` "deletes refs whose source branch is not in the
   keep set" and the same sync ordering test above, which also asserts
   `clearStale` runs before `fetch`.
4. **User `FETCH_HEAD` is untouched** — `--no-write-fetch-head` is now
   passed on every fetch. Verified by `src/lib/git.test.ts` "leaves the
   user FETCH_HEAD untouched (--no-write-fetch-head)", which writes a
   sentinel into `.git/FETCH_HEAD`, runs `fetchBranches`, and asserts the
   file is byte-for-byte unchanged.
5. **No tags fetched** — `--no-tags` is on every fetch. Verified by
   `src/lib/git.test.ts` "does not fetch remote tags (--no-tags)", which
   pushes a tag to the remote, runs `fetchBranches`, and asserts
   `git tag -l` is empty locally.

Manually validated against real git (separate scratch repo) that explicit
refspec `feat:refs/dubstack/fetch-head/feat` still opportunistically updates
`refs/remotes/origin/feat`, so existing call sites that read `origin/<branch>`
keep working without changes.

## Evidence

- `pnpm checks` — passed (biome check, 0 errors).
- `pnpm typecheck` — passed (turbo, both packages).
- `pnpm test` — 508/508 passed across 68 files, including 41 in
  `src/lib/git.test.ts` (with the four new behaviors covered) and the
  expanded `src/commands/sync.test.ts` ordering test.
- `pnpm check:all` — `checks`, `typecheck`, `test` all pass; `evals` fails
  only because of a pre-existing `better-sqlite3` NODE_MODULE_VERSION
  mismatch in the local node_modules (unrelated to this change; this PR
  does not touch AI metadata or prompts).

## Follow-up flag

None.
