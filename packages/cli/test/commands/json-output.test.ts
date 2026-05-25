/**
 * End-to-end snapshot tests for every `--json` read command. Each test runs
 * against a real test git repo, exercises the underlying command function,
 * wraps the result with `withSchemaVersion`, and asserts the wire shape.
 *
 * Failures in these tests indicate a breaking change to a published JSON
 * schema. Bump `SCHEMA_VERSION` and update {@link
 * import('../../src/lib/json-schemas').SchemaVersion} consumers in lockstep.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { branchInfo } from '../../src/commands/branch';
import { children } from '../../src/commands/children';
import { create } from '../../src/commands/create';
import { doctor } from '../../src/commands/doctor';
import { history } from '../../src/commands/history';
import { init } from '../../src/commands/init';
import { logJson } from '../../src/commands/log';
import { parent } from '../../src/commands/parent';
import { ready } from '../../src/commands/ready';
import { trunk } from '../../src/commands/trunk';
import { SCHEMA_VERSION, withSchemaVersion } from '../../src/lib/json-schemas';
import { createTestRepo, gitInRepo } from '../helpers';

let dir: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  const repo = await createTestRepo();
  dir = repo.dir;
  cleanup = repo.cleanup;
  await init(dir);
  await gitInRepo(dir, ['add', '.']);
  await gitInRepo(dir, ['commit', '-m', 'init dubstack']);
  await create('feat/a', dir);
  await create('feat/b', dir);
});

afterEach(async () => {
  await cleanup();
});

describe('json output schemas', () => {
  it('parent --json carries schemaVersion 1', async () => {
    const result = withSchemaVersion(await parent(dir));
    expect(result.schemaVersion).toBe(SCHEMA_VERSION);
    expect(result).toMatchObject({
      schemaVersion: 1,
      branch: 'feat/b',
      parent: 'feat/a',
    });
  });

  it('children --json carries schemaVersion 1 and a sorted list', async () => {
    await gitInRepo(dir, ['checkout', 'main']);
    const result = withSchemaVersion(await children(dir));
    expect(result).toEqual({
      schemaVersion: 1,
      branch: 'main',
      children: ['feat/a'],
    });
  });

  it('trunk --json carries schemaVersion 1', async () => {
    const result = withSchemaVersion(await trunk(dir));
    expect(result).toEqual({
      schemaVersion: 1,
      branch: 'feat/b',
      trunk: 'main',
    });
  });

  it('info/branch --json carries schemaVersion 1', async () => {
    const result = withSchemaVersion(await branchInfo(dir));
    expect(result.schemaVersion).toBe(1);
    expect(result).toMatchObject({
      currentBranch: 'feat/b',
      tracked: true,
      parent: 'feat/a',
      children: [],
    });
  });

  it('log --json carries schemaVersion 1 and the stack tree', async () => {
    const result = withSchemaVersion(await logJson(dir));
    expect(result.schemaVersion).toBe(1);
    expect(result.currentBranch).toBe('feat/b');
    expect(result.stacks).toHaveLength(1);
    expect(result.stacks[0]?.root?.name).toBe('main');
  });

  it('doctor --json carries schemaVersion 1', async () => {
    // skipGithub keeps the run hermetic — no `gh` calls in the test sandbox.
    const result = withSchemaVersion(
      await doctor(dir, { fetch: false, skipGithub: true }),
    );
    expect(result.schemaVersion).toBe(1);
    expect(result.checkedBranch).toBe('feat/b');
    expect(Array.isArray(result.issues)).toBe(true);
    expect(Array.isArray(result.notices)).toBe(true);
    expect(typeof result.healthy).toBe('boolean');
  });

  it('history --json carries schemaVersion 1', async () => {
    const result = withSchemaVersion(await history(dir));
    expect(result.schemaVersion).toBe(1);
    expect(Array.isArray(result.entries)).toBe(true);
  });

  it('ready --json carries schemaVersion 1', async () => {
    // Bypass gh-dependent submit preflight by exercising the function directly
    // and asserting only the envelope and top-level shape we contract on.
    const result = withSchemaVersion(await ready(dir, { scope: 'current' }));
    expect(result.schemaVersion).toBe(1);
    expect(typeof result.ready).toBe('boolean');
    expect(result.scope).toBe('current');
    expect(result.checkedBranch).toBe('feat/b');
    expect(Array.isArray(result.blockers)).toBe(true);
  });
});
