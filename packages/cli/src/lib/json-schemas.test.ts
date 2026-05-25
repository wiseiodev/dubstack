import { describe, expect, it } from 'vitest';
import {
  jsonErrorEnvelope,
  SCHEMA_VERSION,
  withSchemaVersion,
} from './json-schemas';

describe('json-schemas helpers', () => {
  it('exposes a numeric major version', () => {
    expect(SCHEMA_VERSION).toBe(1);
  });

  it('stamps schemaVersion on a payload', () => {
    const stamped = withSchemaVersion({ branch: 'feat/a', parent: 'main' });
    expect(stamped).toEqual({
      schemaVersion: 1,
      branch: 'feat/a',
      parent: 'main',
    });
  });

  it('overrides any inline schemaVersion on the payload', () => {
    // The canonical constant must win so a stale inline value cannot silently
    // shadow the helper's contract.
    const stamped = withSchemaVersion({
      schemaVersion: 99,
      currentBranch: 'feat/a',
    });
    expect(stamped.schemaVersion).toBe(1);
    expect(stamped.currentBranch).toBe('feat/a');
  });

  it('builds an error envelope with recovery hints', () => {
    expect(
      jsonErrorEnvelope("Branch 'feat/x' is not tracked.", [
        "Run 'dub track feat/x --parent main'.",
      ]),
    ).toEqual({
      schemaVersion: 1,
      error: {
        message: "Branch 'feat/x' is not tracked.",
        recovery: ["Run 'dub track feat/x --parent main'."],
      },
    });
  });

  it('builds an error envelope with empty recovery by default', () => {
    expect(jsonErrorEnvelope('Cancelled.')).toEqual({
      schemaVersion: 1,
      error: { message: 'Cancelled.', recovery: [] },
    });
  });
});
