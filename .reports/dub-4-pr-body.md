## TL;DR

`dub sync` now leaves the user's `FETCH_HEAD` untouched, skips tag transfer, and clears deleted-remote-branch ghost refs before fast-forwarding trunk. Fetched tips land in a private `refs/dubstack/fetch-head/<branch>` namespace; the same opportunistic update keeps `origin/<branch>` current for downstream sync logic.

## Why

Users running `git fetch` manually expect `FETCH_HEAD` to reflect THEIR last fetch, not DubStack's background sync.

On repos with many release tags, `git fetch origin <branch>` pulls every reachable tag, which is wasted bandwidth. `--no-tags` matches Graphite's v1.6.2 optimization.

Stale `refs/remotes/origin/<branch>` ghost refs from deleted-remote branches confuse trunk fast-forward and the cleanup heuristics.

### Before

- `fetchBranches` ran `git fetch <remote> <branch>`, which writes `FETCH_HEAD` and pulls all reachable tags.
- Sync never pruned the remote, so branches deleted on origin still appeared via stale tracking refs.
- No private fetch namespace existed; nothing to clean up at sync start.

### After

- `fetchBranches` runs `git fetch --no-write-fetch-head --no-tags -f origin <branch>:refs/dubstack/fetch-head/<branch>`, leaving FETCH_HEAD alone and skipping tags.
- Sync calls `clearStaleNamespacedFetchRefs` at the top of the run, deleting any `refs/dubstack/fetch-head/*` entry whose source branch is no longer tracked in DubStack state.
- Sync calls `git remote prune origin` once between fetch and trunk fast-forward.

## File-by-file

### packages/cli/src/lib/git.ts

mod +89 / -2

Exports the `DUBSTACK_FETCH_REF_PREFIX` constant + `namespacedFetchRef` helper. Rewrites `fetchBranches` to use the namespaced refspec with `--no-write-fetch-head --no-tags -f`. Adds `listNamespacedFetchRefs`, `deleteRef`, `clearStaleNamespacedFetchRefs`, and `pruneRemote` so `sync` can drive the namespace cleanup and remote prune.

```typescript
export const DUBSTACK_FETCH_REF_PREFIX = 'refs/dubstack/fetch-head/';

export async function fetchBranches(branches, cwd, remote = 'origin') {
  if (branches.length === 0) return;
  for (const branch of branches) {
    const refspec = `${branch}:${namespacedFetchRef(branch)}`;
    await execa('git', ['fetch', '--no-write-fetch-head', '--no-tags', '-f', remote, refspec], { cwd });
  }
}
```

### packages/cli/src/commands/sync.ts

mod +9 / -0

Imports the two new git helpers. Computes the keep-set from the full state (`state.stacks`, not just the scoped stacks) so a partial `dub sync` never deletes namespaced refs that belong to other tracked stacks. Calls `clearStaleNamespacedFetchRefs` at the top of the `try` block, then `pruneRemote('origin', cwd)` after `fetchBranches` and before the trunk fast-forward loop.

```typescript
const allTrackedBranches = new Set(
  state.stacks.flatMap((s) => s.branches.map((b) => b.name)),
);
await clearStaleNamespacedFetchRefs(allTrackedBranches, cwd);

console.log('🌲 Fetching branches from remote...');
const toFetch = [...new Set([...roots, ...stackBranches])];
if (toFetch.length > 0) {
  await fetchBranches(toFetch, cwd);
  result.fetched = toFetch;
}

await pruneRemote('origin', cwd);
```

### packages/cli/src/lib/git.test.ts

mod +127 / -1

Real-git integration tests for the four behaviors: namespaced ref written, FETCH_HEAD untouched, no tags fetched, missing remote refs skipped. Plus unit-style coverage for `clearStaleNamespacedFetchRefs` (delete-only-stale) and `pruneRemote` (happy path + bad-remote DubError).

```typescript
it('leaves the user FETCH_HEAD untouched (--no-write-fetch-head)', async () => {
  const fetchHeadPath = path.join(dir, '.git', 'FETCH_HEAD');
  const manualContent = 'sentinel value written by user\n';
  fs.writeFileSync(fetchHeadPath, manualContent);
  await fetchBranches(['feat/a'], dir);
  expect(fs.readFileSync(fetchHeadPath, 'utf8')).toBe(manualContent);
});
```

### packages/cli/src/commands/sync.test.ts

mod +52 / -0

Mocks the two new git helpers and adds an ordering test that asserts `clearStale → fetch → prune → trunk fast-forward` and that the keep-set passed to `clearStaleNamespacedFetchRefs` is the full state, not just the scoped stacks.

```typescript
expect(callOrder.indexOf('clearStale')).toBeLessThan(callOrder.indexOf('fetch'));
expect(callOrder.indexOf('prune')).toBeLessThan(callOrder.indexOf('ff:main'));
```

### packages/cli/test/helpers.ts

mod +28 / -0

Adds `attachBareRemote(localDir)` helper that creates a bare repo in tmp and configures it as `origin` on the given local repo, so git.test.ts can drive real fetches end-to-end.

```typescript
export async function attachBareRemote(localDir) {
  const remoteDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dubstack-test-remote-'));
  await execa('git', ['init', '-b', 'main', '--bare'], { cwd: remoteDir, env: GIT_TEST_ENV });
  await execa('git', ['remote', 'add', 'origin', remoteDir], { cwd: localDir, env: GIT_TEST_ENV });
  return { remoteDir, cleanup: async () => fs.promises.rm(remoteDir, { recursive: true, force: true }) };
}
```

## Where to focus review

1. **Opportunistic origin/<branch> updates are still relied on** - `packages/cli/src/commands/sync.ts:175,270 + packages/cli/src/lib/git.ts:fetchBranches`: Downstream sync logic (`fastForwardBranchToRef`, `hardResetBranchToRef`, `remoteBranchExists`, `isAncestor`) still reads `origin/<branch>` rather than the new namespaced ref. This is intentional and safe — when the explicit refspec `<branch>:refs/dubstack/fetch-head/<branch>` is given, git still opportunistically updates `refs/remotes/origin/<branch>` via the configured `+refs/heads/*:refs/remotes/origin/*` refspec. Verified manually in a scratch repo. Worth a careful eye in review.
2. **Keep-set for stale-ref cleanup uses full state, not scoped stacks** - `packages/cli/src/commands/sync.ts:158-163`: `clearStaleNamespacedFetchRefs(allTrackedBranches, cwd)` deliberately uses `state.stacks` (every tracked stack), not `scopeStacks`, so a single-stack `dub sync` never deletes namespaced refs belonging to other stacks the user is still tracking. Confirm this matches expected semantics.
3. **Prune ordering vs. fetch** - `packages/cli/src/commands/sync.ts after fetchBranches call`: `git remote prune origin` runs AFTER `fetchBranches`. The fetch creates/updates namespaced refs and opportunistically refreshes `origin/<branch>`; the subsequent prune only removes `refs/remotes/origin/<branch>` entries that have no counterpart on the remote. This is safe because the just-fetched refs reference branches that DO exist on origin and won't be pruned.

## Test plan

- [x] **unit:** fetchBranches writes namespaced ref + leaves FETCH_HEAD alone + skips tags + skips missing remote refs - src/lib/git.test.ts `describe('fetchBranches')` — four real-git tests against a bare remote.
- [x] **unit:** clearStaleNamespacedFetchRefs deletes only refs whose source branch is not in the keep set - src/lib/git.test.ts `describe('clearStaleNamespacedFetchRefs')` — two tests.
- [x] **unit:** pruneRemote happy path and bad-remote DubError - src/lib/git.test.ts `describe('pruneRemote')` — two tests.
- [x] **integration:** sync orders clearStale → fetch → prune → trunk fast-forward and passes the full tracked-branch set as keep - src/commands/sync.test.ts `clears stale namespaced fetch refs and prunes remote once before trunk pull`.
- [x] **manual:** Confirmed in scratch repo that explicit refspec still opportunistically updates refs/remotes/origin/* - /tmp scratch repos: fetched with the new refspec, observed both `refs/dubstack/fetch-head/feature` and `refs/remotes/origin/feature` updated by a single `git fetch` call.

## Quality gates

- **biome check:** `pnpm checks` - passed (Checked 188 files in 28ms. No fixes applied.)
- **typecheck:** `pnpm typecheck` - passed (turbo: 2 successful, 2 total. dubstack:typecheck and docs:typecheck both clean.)
- **unit tests:** `pnpm test` - passed (Test Files: 68 passed (68). Tests: 508 passed (508). Includes 41 in src/lib/git.test.ts (with the new behaviors) and the expanded src/commands/sync.test.ts.)
- **evals:** `pnpm evals` - not_available (Pre-existing `better-sqlite3` NODE_MODULE_VERSION mismatch in local node_modules. Unrelated to this change; this PR does not touch AI metadata or prompts, so per AGENTS.md evals are not required.)

## Self-QA

See [QA fallback evidence](.reports/dub-4-qa.md).

Deterministic proof via test logs and manual scratch-repo verification of opportunistic ref updates.

- Fetch a moved remote branch and assert the namespaced ref equals the remote tip.
- Pre-write a sentinel to .git/FETCH_HEAD, fetch, assert the sentinel is byte-identical.
- Push a tag to remote, fetch, assert `git tag -l` is empty locally.
- Create stale and live entries under refs/dubstack/fetch-head/, run cleanup, assert only the stale one is deleted.
- Sync ordering: clearStale → fetch → prune → trunk fast-forward, with the full tracked-branch set as keep.

## Acceptance criteria

- [x] fetchBranches in lib/git.ts uses namespaced refs and the flag set above - packages/cli/src/lib/git.ts fetchBranches now runs `git fetch --no-write-fetch-head --no-tags -f origin <branch>:refs/dubstack/fetch-head/<branch>`. Covered by `src/lib/git.test.ts 'writes fetched tip to refs/dubstack/fetch-head/<branch>'`.
- [x] Sync calls git remote prune once before trunk pull - packages/cli/src/commands/sync.ts calls `pruneRemote('origin', cwd)` between `fetchBranches` and the `for (const root of roots)` trunk fast-forward loop. Ordering asserted in `src/commands/sync.test.ts 'clears stale namespaced fetch refs and prunes remote once before trunk pull'`.
- [x] Stale refs/dubstack/fetch-head/* cleared at sync start - Top of the sync `try` block calls `clearStaleNamespacedFetchRefs(allTrackedBranches, cwd)`. Behavior covered by `src/lib/git.test.ts 'deletes refs whose source branch is not in the keep set'` and the ordering test in `sync.test.ts`.
- [x] User's own FETCH_HEAD is untouched after dub sync - `--no-write-fetch-head` on every fetch. `src/lib/git.test.ts 'leaves the user FETCH_HEAD untouched (--no-write-fetch-head)'` writes a sentinel into .git/FETCH_HEAD before fetch and asserts byte-equality after.
- [x] No tags fetched (verify by checking refs after sync against a repo with tags) - `--no-tags` on every fetch. `src/lib/git.test.ts 'does not fetch remote tags (--no-tags)'` pushes a tag to the remote, runs fetchBranches, and asserts `git tag -l` returns nothing locally.
- [x] Tests for all four behaviors - All four behaviors plus the missing-remote-ref edge case and the sync-ordering invariant are covered. Total 508/508 tests pass.

## Adversarial review

Iterations: 1

Remaining critical/major: 0/0

Remaining minor/nitpick: 0/0

- Reviewer raised theoretical concern that sync still reads `origin/<branch>` rather than the namespaced ref. Investigated and resolved: opportunistic refspec update keeps `origin/<branch>` current, the new `git remote prune origin` actively removes stale tracking refs (strictly safer than the pre-PR behavior), and the issue's scope is explicitly limited to `fetchBranches` and the top of `sync.ts`. No regression vs. pre-PR behavior.

## Dependencies

- **Linear DUB-4 description / acceptance criteria:** intake complete
- **Graphite Charcoal fetch discipline (reference, public):** intake complete
- **No external dependencies blocking:** satisfied

## Rollout

Standalone behavior change inside `dub sync`. No flag, no migration, no user action required. Existing repos with refs under `refs/dubstack/fetch-head/` (none today) would be cleaned up automatically on the next sync.

- **On merge - Merge to main:** Standard squash-merge per repo conventions.
- **On next dub sync - Namespace populated:** Each fetched branch lands at refs/dubstack/fetch-head/<branch>. User FETCH_HEAD untouched from that point on.
- **On next dub sync after a branch deletion - Stale namespace + tracking refs cleaned:** clearStaleNamespacedFetchRefs removes refs for branches no longer tracked; git remote prune origin removes tracking refs for branches deleted on origin.

## Commit

```text
feat(cli): namespaced fetch refs + --no-tags + remote prune in sync
```
