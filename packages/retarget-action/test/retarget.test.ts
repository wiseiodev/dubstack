import { describe, expect, it } from 'vitest';
import { parseDubstackMetadata } from '../src/pr-body-parser.js';
import {
  RetargetPermissionsError,
  removeBranchFromTree,
  runRetarget,
} from '../src/retarget.js';
import linearStackFixture from './fixtures/linear-stack.json' with {
  type: 'json',
};
import noMetadataFixture from './fixtures/no-metadata.json' with {
  type: 'json',
};
import treeStackFixture from './fixtures/tree-stack.json' with { type: 'json' };
import {
  buildStackFakes,
  createRecordingClient,
  type FakePullBranch,
  makeMergedInput,
  makeOpenPulls,
  silentLogger,
} from './helpers.js';

describe('runRetarget', () => {
  it('retargets dependents on a linear 3-deep stack when the bottom PR merges', async () => {
    const branches: FakePullBranch[] = [
      { number: 0, branch: 'main', parent: null, depth: 0 },
      { number: 1, branch: 'feat/a', parent: 'main', depth: 1 },
      { number: 2, branch: 'feat/b', parent: 'feat/a', depth: 2 },
      { number: 3, branch: 'feat/c', parent: 'feat/b', depth: 3 },
    ];
    const fakes = buildStackFakes({
      stackId: linearStackFixture.stack_id,
      trunk: linearStackFixture.trunk,
      branches,
    });
    const merged = makeMergedInput(fakes, 'feat/a', 1, 'main');
    const openPulls = makeOpenPulls(fakes, [
      { number: 2, branch: 'feat/b', base: 'feat/a' },
      { number: 3, branch: 'feat/c', base: 'feat/b' },
    ]);
    const client = createRecordingClient(openPulls);

    const outcome = await runRetarget(client, merged, silentLogger());

    expect(outcome.status).toBe('done');
    if (outcome.status !== 'done') return;
    expect(outcome.retargeted).toEqual([
      { number: 2, fromBase: 'feat/a', toBase: 'main' },
    ]);
    expect(client.calls.baseUpdates).toEqual([{ number: 2, base: 'main' }]);
    expect(client.calls.bodyUpdates).toHaveLength(1);
    expect(client.calls.comments).toHaveLength(1);
    expect(client.calls.comments[0]).toMatchObject({ number: 2 });
    expect(client.calls.comments[0].body).toContain('from `feat/a`');
    expect(client.calls.comments[0].body).toContain('to `main`');
    expect(client.calls.comments[0].body).toContain('#1');

    // The retargeted PR's metadata must now name `main` as parent and drop
    // feat/a from the tree.
    const updated = client.calls.bodyUpdates[0].body;
    const meta = parseDubstackMetadata(updated);
    expect(meta).not.toBeNull();
    expect(meta?.parent).toBe('main');
    expect(meta?.tree.find((n) => n.name === 'feat/a')).toBeUndefined();
    expect(meta?.tree.find((n) => n.name === 'feat/b')?.depth).toBe(1);
    expect(meta?.tree.find((n) => n.name === 'feat/c')?.depth).toBe(2);
  });

  it('retargets only the dependent subtree on a sibling tree merge', async () => {
    const branches: FakePullBranch[] = [
      { number: 0, branch: 'main', parent: null, depth: 0 },
      { number: 1, branch: 'feat/a', parent: 'main', depth: 1 },
      { number: 2, branch: 'feat/b', parent: 'feat/a', depth: 2 },
      { number: 3, branch: 'feat/c', parent: 'feat/b', depth: 3 },
      { number: 4, branch: 'feat/d', parent: 'feat/a', depth: 2 },
    ];
    const fakes = buildStackFakes({
      stackId: treeStackFixture.stack_id,
      trunk: treeStackFixture.trunk,
      branches,
    });
    const merged = makeMergedInput(fakes, 'feat/b', 2, 'feat/a');
    const openPulls = makeOpenPulls(fakes, [
      { number: 1, branch: 'feat/a', base: 'main' },
      { number: 3, branch: 'feat/c', base: 'feat/b' },
      { number: 4, branch: 'feat/d', base: 'feat/a' },
    ]);
    const client = createRecordingClient(openPulls);

    const outcome = await runRetarget(client, merged, silentLogger());

    expect(outcome.status).toBe('done');
    if (outcome.status !== 'done') return;
    expect(outcome.retargeted).toEqual([
      { number: 3, fromBase: 'feat/b', toBase: 'feat/a' },
    ]);
    expect(client.calls.baseUpdates).toEqual([{ number: 3, base: 'feat/a' }]);
    expect(
      client.calls.baseUpdates.find((c) => c.number === 4),
    ).toBeUndefined();
    expect(
      client.calls.baseUpdates.find((c) => c.number === 1),
    ).toBeUndefined();
  });

  it('exits silently when the merged PR has no dubstack-metadata block', async () => {
    const client = createRecordingClient([]);
    const outcome = await runRetarget(
      client,
      {
        number: 99,
        merged: true,
        body: noMetadataFixture.body,
        base: { ref: 'main' },
      },
      silentLogger(),
    );
    expect(outcome.status).toBe('skipped-no-metadata');
    expect(client.calls.listed).toBe(0);
    expect(client.calls.baseUpdates).toEqual([]);
    expect(client.calls.bodyUpdates).toEqual([]);
    expect(client.calls.comments).toEqual([]);
  });

  it('exits silently when the PR did not actually merge', async () => {
    const client = createRecordingClient([]);
    const outcome = await runRetarget(
      client,
      {
        number: 5,
        merged: false,
        body: 'whatever',
        base: { ref: 'main' },
      },
      silentLogger(),
    );
    expect(outcome.status).toBe('skipped-not-merged');
    expect(client.calls.listed).toBe(0);
  });

  it('logs and exits when metadata is legacy-shaped (no parent / no tree)', async () => {
    const legacyBody = `## Summary\n\n<!-- dubstack-metadata\n${JSON.stringify(
      {
        stack_id: 'stk_legacy',
        pr_number: 12,
        branch: 'feat/legacy',
        prev_pr: null,
        next_pr: null,
      },
      null,
      2,
    )}\n-->`;
    const client = createRecordingClient([]);
    const outcome = await runRetarget(
      client,
      {
        number: 12,
        merged: true,
        body: legacyBody,
        base: { ref: 'main' },
      },
      silentLogger(),
    );
    expect(outcome.status).toBe('skipped-legacy-metadata');
    expect(client.calls.baseUpdates).toEqual([]);
  });

  it('skips dependents queued to auto-merge', async () => {
    const branches: FakePullBranch[] = [
      { number: 0, branch: 'main', parent: null, depth: 0 },
      { number: 1, branch: 'feat/a', parent: 'main', depth: 1 },
      { number: 2, branch: 'feat/b', parent: 'feat/a', depth: 2 },
    ];
    const fakes = buildStackFakes({
      stackId: 'stk',
      trunk: 'main',
      branches,
    });
    const merged = makeMergedInput(fakes, 'feat/a', 1, 'main');
    const openPulls = makeOpenPulls(fakes, [
      {
        number: 2,
        branch: 'feat/b',
        base: 'feat/a',
        auto_merge: { enabled_by: { login: 'someone' } },
      },
    ]);
    const client = createRecordingClient(openPulls);

    const outcome = await runRetarget(client, merged, silentLogger());

    expect(outcome.status).toBe('done');
    if (outcome.status !== 'done') return;
    expect(outcome.retargeted).toEqual([]);
    expect(outcome.skipped).toEqual([
      { number: 2, reason: 'auto-merge in flight' },
    ]);
    expect(client.calls.baseUpdates).toEqual([]);
  });

  it('refreshes stale metadata when the base is already correct (manual retarget)', async () => {
    const branches: FakePullBranch[] = [
      { number: 0, branch: 'main', parent: null, depth: 0 },
      { number: 1, branch: 'feat/a', parent: 'main', depth: 1 },
      { number: 2, branch: 'feat/b', parent: 'feat/a', depth: 2 },
    ];
    const fakes = buildStackFakes({
      stackId: 'stk',
      trunk: 'main',
      branches,
    });
    const merged = makeMergedInput(fakes, 'feat/a', 1, 'main');
    // A teammate moved #2's base to main via the GitHub UI, but the embedded
    // dubstack-metadata still names feat/a as parent. The action must NOT
    // double-update the base, but MUST refresh the metadata.
    const openPulls = makeOpenPulls(fakes, [
      { number: 2, branch: 'feat/b', base: 'main' },
    ]);
    const client = createRecordingClient(openPulls);

    const outcome = await runRetarget(client, merged, silentLogger());

    expect(outcome.status).toBe('done');
    if (outcome.status !== 'done') return;
    expect(outcome.retargeted).toEqual([]);
    expect(outcome.skipped).toEqual([
      { number: 2, reason: 'metadata refreshed; base unchanged' },
    ]);
    expect(client.calls.baseUpdates).toEqual([]);
    expect(client.calls.bodyUpdates).toHaveLength(1);
    // No comment when no actual retarget happened.
    expect(client.calls.comments).toEqual([]);
    const refreshed = parseDubstackMetadata(client.calls.bodyUpdates[0].body);
    expect(refreshed?.parent).toBe('main');
  });

  it('skips entirely when both base and metadata are already correct', async () => {
    const branches: FakePullBranch[] = [
      { number: 0, branch: 'main', parent: null, depth: 0 },
      { number: 1, branch: 'feat/a', parent: 'main', depth: 1 },
      // Already-retargeted shape: feat/b's parent is `main`, not feat/a.
      { number: 2, branch: 'feat/b', parent: 'main', depth: 1 },
    ];
    const fakes = buildStackFakes({
      stackId: 'stk',
      trunk: 'main',
      branches,
    });
    // Merged PR's stored metadata sees its child feat/b as a sibling at depth 1
    // (since both share `main` as parent). Build merged body separately from
    // a hand-tuned tree that still names feat/b as a child for the parent
    // lookup — easier to assert with explicit dependents matching.
    const merged = makeMergedInput(fakes, 'feat/a', 1, 'main');
    const openPulls = makeOpenPulls(fakes, [
      { number: 2, branch: 'feat/b', base: 'main' },
    ]);
    const client = createRecordingClient(openPulls);

    const outcome = await runRetarget(client, merged, silentLogger());

    // feat/b's parent is already `main`, so it's not even a dependent in the
    // first place — runRetarget returns 'no-dependents'.
    expect(outcome.status).toBe('no-dependents');
    expect(client.calls.baseUpdates).toEqual([]);
    expect(client.calls.bodyUpdates).toEqual([]);
  });

  it('continues when body rewrite fails after base update', async () => {
    const branches: FakePullBranch[] = [
      { number: 0, branch: 'main', parent: null, depth: 0 },
      { number: 1, branch: 'feat/a', parent: 'main', depth: 1 },
      { number: 2, branch: 'feat/b', parent: 'feat/a', depth: 2 },
    ];
    const fakes = buildStackFakes({
      stackId: 'stk',
      trunk: 'main',
      branches,
    });
    const merged = makeMergedInput(fakes, 'feat/a', 1, 'main');
    const openPulls = makeOpenPulls(fakes, [
      { number: 2, branch: 'feat/b', base: 'feat/a' },
    ]);
    const client = createRecordingClient(openPulls);
    // Override updatePullBody to throw — the action should still report
    // success on the retarget itself.
    const original = client.updatePullBody.bind(client);
    client.updatePullBody = async () => {
      throw new Error('rate limited');
    };
    void original;

    const outcome = await runRetarget(client, merged, silentLogger());
    expect(outcome.status).toBe('done');
    if (outcome.status !== 'done') return;
    expect(outcome.retargeted).toEqual([
      { number: 2, fromBase: 'feat/a', toBase: 'main' },
    ]);
    expect(client.calls.baseUpdates).toEqual([{ number: 2, base: 'main' }]);
  });

  it('throws RetargetPermissionsError with workflow hint on 403', async () => {
    const branches: FakePullBranch[] = [
      { number: 0, branch: 'main', parent: null, depth: 0 },
      { number: 1, branch: 'feat/a', parent: 'main', depth: 1 },
      { number: 2, branch: 'feat/b', parent: 'feat/a', depth: 2 },
    ];
    const fakes = buildStackFakes({
      stackId: 'stk',
      trunk: 'main',
      branches,
    });
    const merged = makeMergedInput(fakes, 'feat/a', 1, 'main');
    const openPulls = makeOpenPulls(fakes, [
      { number: 2, branch: 'feat/b', base: 'feat/a' },
    ]);
    const client = createRecordingClient(openPulls, {
      onUpdateBase: () => {
        const err = new Error('Resource not accessible by integration');
        Object.assign(err, { status: 403 });
        throw err;
      },
    });

    await expect(
      runRetarget(client, merged, silentLogger()),
    ).rejects.toBeInstanceOf(RetargetPermissionsError);
  });

  it('exits with no-dependents when no open PR points at the merged branch', async () => {
    const branches: FakePullBranch[] = [
      { number: 0, branch: 'main', parent: null, depth: 0 },
      { number: 1, branch: 'feat/a', parent: 'main', depth: 1 },
    ];
    const fakes = buildStackFakes({
      stackId: 'stk',
      trunk: 'main',
      branches,
    });
    const merged = makeMergedInput(fakes, 'feat/a', 1, 'main');
    // Unrelated open PR, points at main, not our stack.
    const openPulls = makeOpenPulls(fakes, []);
    const client = createRecordingClient(openPulls);

    const outcome = await runRetarget(client, merged, silentLogger());
    expect(outcome.status).toBe('no-dependents');
    expect(client.calls.baseUpdates).toEqual([]);
  });
});

describe('removeBranchFromTree', () => {
  it('shifts descendants up but leaves siblings untouched', () => {
    const tree = [
      { name: 'main', depth: 0 },
      { name: 'feat/a', depth: 1, pr_number: 1 },
      { name: 'feat/b', depth: 2, pr_number: 2 },
      { name: 'feat/c', depth: 3, pr_number: 3 },
      { name: 'feat/d', depth: 2, pr_number: 4 },
    ];
    const result = removeBranchFromTree(tree, 'feat/b');
    expect(result).toEqual([
      { name: 'main', depth: 0 },
      { name: 'feat/a', depth: 1, pr_number: 1 },
      { name: 'feat/c', depth: 2, pr_number: 3 },
      { name: 'feat/d', depth: 2, pr_number: 4 },
    ]);
  });

  it('returns the tree unchanged when the branch is absent', () => {
    const tree = [
      { name: 'main', depth: 0 },
      { name: 'feat/a', depth: 1 },
    ];
    expect(removeBranchFromTree(tree, 'feat/nope')).toBe(tree);
  });
});
