## TL;DR

pushBranch now uses --force-with-lease=refs/heads/<branch>:<trackedSha> against a locally-maintained ref under refs/dubstack/last-pushed/<branch>. The tracking ref is only written by pushBranch itself on a successful push, so background fetches can't move it. Lease rejections surface a DubError pointing the user at `dub sync`.

## Why

Without --force-with-lease, dub submit can silently overwrite teammate pushes during the same branch's lifecycle.

Bare --force-with-lease leases against refs/remotes/origin/<branch>, which IDE/tool background fetches update silently — defeating the lease (the 'Graphite gotcha').

Maintaining our own refs/dubstack/last-pushed/<branch> and leasing against it scopes the lease to state only dub touches.

### Before

- pushBranch ran `git push --force-with-lease origin <branch>` with no expect value.
- Background `git fetch` from any tool could move refs/remotes/origin/<branch> to a third-party SHA, making the bare lease succeed against that updated tracking ref.
- Push generic-errored with 'Failed to push' on rejection — no specific recovery for lease failures.

### After

- pushBranch reads refs/dubstack/last-pushed/<branch> and pushes with --force-with-lease=refs/heads/<branch>:<trackedSha>.
- On success it updates the tracking ref to the freshly-pushed SHA, so the next push is protected against any new third-party work.
- Lease rejections raise DubError('Push of \'<branch>\' refused: remote has updates not reflected in our last-pushed ref.') with a recovery hint to run `dub sync`.

## File-by-file

### packages/cli/src/lib/git.ts

mod +107 / -10

Replaces the bare --force-with-lease pushBranch with one keyed on refs/dubstack/last-pushed/<branch>. Adds helpers lastPushedRef, readLastPushedSha, writeLastPushedSha, plus isLeaseRejectionError to distinguish lease failures from generic push errors.

```typescript
export async function pushBranch(branch: string, cwd: string): Promise<void> {
  const trackedSha = await readLastPushedSha(branch, cwd);
  const leaseArg = trackedSha
    ? `--force-with-lease=refs/heads/${branch}:${trackedSha}`
    : '--force-with-lease';

  try {
    await execa('git', ['push', leaseArg, 'origin', branch], { cwd });
  } catch (error) {
    const details = readGitCommandOutput(error);
    if (isLeaseRejectionError(details)) {
      throw new DubError(
        formatGitFailure(
          `Push of '${branch}' refused: remote has updates not reflected in our last-pushed ref.`,
          details,
        ),
        [
          `Run 'dub sync' to reconcile remote updates, then retry 'dub submit'.`,
          `Run 'git fetch origin ${branch}' and inspect 'origin/${branch}' to see the third-party changes.`,
        ],
      );
    }
    throw new DubError(
      formatGitFailure(`Failed to push '${branch}'.`, details),
      [
        `Run 'dub sync' to reconcile remote updates, then retry the push.`,
        `Run 'git push --force-with-lease origin ${branch}' manually to see the underlying error.`,
      ],
    );
  }

  const newSha = await getBranchTip(branch, cwd);
  await writeLastPushedSha(branch, newSha, cwd);
}
```

### packages/cli/src/lib/git.test.ts

mod +104 / -0

Adds a pushBranch describe-block that runs real git pushes against a bare remote in a temp dir. Tests cover: first-push records the tracked SHA; second push succeeds when tracked SHA matches reality; concurrent third-party push triggers a lease error, surfaces the recovery hint, and leaves the tracked SHA unchanged so retry-after-sync works.

```typescript
it('refuses with a lease error when a third party pushed concurrently', async () => {
  await pushBranch('feat/lease', dir);
  const trackedSha = await readLastPushedSha('feat/lease', dir);
  // ...clone bare remote into otherDir, third-party commit, push...
  await gitInRepo(dir, ['fetch', 'origin', 'feat/lease']);

  const err = await pushBranch('feat/lease', dir).catch((e) => e);
  expect(err).toBeInstanceOf(DubError);
  expect(err.message).toMatch(
    /refused: remote has updates not reflected in our last-pushed ref/,
  );
  expect((err as DubError).recovery.join('\n')).toMatch(/dub sync/);

  expect(await readLastPushedSha('feat/lease', dir)).toBe(trackedSha);
});
```

## Where to focus review

1. **Lease argument shape** - `packages/cli/src/lib/git.ts pushBranch`: Per git docs, --force-with-lease=<refname>:<expect> takes the remote-side ref path (refs/heads/<branch>) and the SHA we expect that ref to currently hold. Confirm refname is constructed correctly and expect comes from the dubstack tracking ref, not from refs/remotes/origin/.
2. **Lease-vs-generic error detection** - `packages/cli/src/lib/git.ts isLeaseRejectionError`: Detection matches 'stale info' (case-insensitive) in concatenated stderr/stdout. This is git's documented message for --force-with-lease rejection. Confirm this won't false-positive on non-lease errors and won't false-negative if git changes wording.
3. **Tracking-ref atomicity on failure** - `packages/cli/src/lib/git.ts pushBranch`: writeLastPushedSha is only called after a successful push. On lease failure the tracked SHA stays at the old value so retry-after-sync still leases correctly. Test 'refuses with a lease error...' asserts this.
4. **First-push fallback gap** - `packages/cli/src/lib/git.ts pushBranch trackedSha branch`: When refs/dubstack/last-pushed/<branch> does not exist (first push), code falls back to bare --force-with-lease, which leases against the stale-prone refs/remotes/origin/<branch>. Documented limitation; not in the issue's acceptance criteria. Confirm this is acceptable.

## Test plan

- [x] **unit:** pushBranch records last-pushed SHA on first push - packages/cli/src/lib/git.test.ts — 'pushes and records the last-pushed SHA on first push'
- [x] **unit:** Lease succeeds when our tracked SHA matches reality on remote (acceptance criterion) - packages/cli/src/lib/git.test.ts — 'lease succeeds when our tracked SHA matches reality on remote'
- [x] **unit:** Concurrent third-party push refuses with lease error (acceptance criterion) - packages/cli/src/lib/git.test.ts — 'refuses with a lease error when a third party pushed concurrently'
- [x] **unit:** lastPushedRef returns the expected ref path - packages/cli/src/lib/git.test.ts — 'returns the dubstack ref path for a branch'

## Quality gates

- **biome lint+format:** `pnpm checks` - passed (Checked 188 files in 49ms. No fixes applied.)
- **typecheck:** `pnpm typecheck` - passed (2 packages clean (dubstack + docs))
- **unit tests:** `pnpm test` - passed (68 test files / 503 tests passed (10.3s))

## Self-QA

See [QA fallback evidence](.reports/dub-5-qa.md).

Fallback QA: 3 new unit tests exercise the lease behavior against a real bare git remote.

- First push records the tracked SHA and matches the remote ref.
- Lease succeeds when our tracked SHA still matches the remote (acceptance criterion).
- Concurrent third-party push triggers a lease error with a `dub sync` recovery hint; the tracked SHA is left unchanged so retry-after-sync works (acceptance criterion).

## Acceptance criteria

- [x] pushBranch uses git push --force-with-lease=<refname>:<sha> with our tracked SHA - packages/cli/src/lib/git.ts pushBranch constructs --force-with-lease=refs/heads/<branch>:<trackedSha> from readLastPushedSha.
- [x] After every successful push from dub submit and dub sync, write refs/dubstack/last-pushed/<branch> to the new SHA - writeLastPushedSha is called at the tail of pushBranch on success. dub submit calls pushBranch directly; dub sync re-submits via submitRefreshedStacks → submit → pushBranch.
- [x] Lease failure surfaces a DubError with recovery hint to run dub sync and retry - isLeaseRejectionError detects 'stale info'; pushBranch throws DubError('Push of <branch> refused: remote has updates not reflected in our last-pushed ref.') with recovery ["Run 'dub sync' to reconcile remote updates, then retry 'dub submit'.", ...].
- [x] Unit test: simulate concurrent third-party push, verify our push refuses with lease error - git.test.ts 'refuses with a lease error when a third party pushed concurrently' — clones bare remote, third-party pushes, asserts DubError with lease message and unchanged tracked SHA.
- [x] Unit test: lease succeeds when our tracked SHA matches reality - git.test.ts 'lease succeeds when our tracked SHA matches reality on remote' — pushes twice without third-party interference, asserts no throw and tracked ref advances.

## Adversarial review

Iterations: 1

Remaining critical/major: 0/0

Remaining minor/nitpick: 1/0

- Reviewer initially flagged a critical that proved to be correct-by-design on re-analysis (lease refname semantics).
- Minor: lease detection via 'stale info' substring is workable for current git but could be brittle across versions. Mitigated by the generic-push-error fallback also listing dub sync as a recovery step.
- Minor (documented as follow-up): first-push fallback uses bare --force-with-lease, which is vulnerable to the same background-fetch race for the very first push only. Not in acceptance criteria; subsequent pushes are fully protected.

## Dependencies

- **External dependencies:** No external dependencies detected

## Rollout

No data migration. Tracking refs (refs/dubstack/last-pushed/<branch>) are created lazily on first successful push per branch. No user-visible config or workflow changes outside the new DubError message on lease failure.

- **On merge - Ship:** Squash-merge into main; semantic-release picks up the feat: commit and publishes a new minor version of the dubstack CLI.
- **After ship - Monitor:** Watch user reports for unexpected 'Push of <branch> refused' errors. Expected legitimate trigger: a teammate pushed to the same branch between our last submit and this one.

## Commit

```text
feat(git): force-with-lease scoped to dubstack-tracked SHA

Switch pushBranch from a bare --force-with-lease to one keyed on our
own refs/dubstack/last-pushed/<branch> tracking ref. The default lease
target (refs/remotes/origin/<branch>) is updated by background fetches
from IDEs and watchers, which silently defeats the lease and lets a
push overwrite a teammate's work. The tracking ref is only written by
pushBranch itself (which is invoked by dub submit and, transitively,
dub sync), so background tools can't move it.

Lease rejections now raise a DubError with a recovery hint to run
'dub sync' and retry.

Completes DUB-5
```
