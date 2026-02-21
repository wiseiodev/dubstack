import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestRepo } from '../../test/helpers';
import { DubError } from '../lib/errors';
import { init } from './init';

let dir: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  const repo = await createTestRepo();
  dir = repo.dir;
  cleanup = repo.cleanup;
});

afterEach(async () => {
  await cleanup();
});

describe('init', () => {
  it('creates state file and gitignore in a fresh repo', async () => {
    const result = await init(dir);
    expect(result.status).toBe('created');
    expect(result.gitignoreUpdated).toBe(true);

    const statePath = path.join(dir, '.git', 'dubstack', 'state.json');
    expect(fs.existsSync(statePath)).toBe(true);
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    expect(state).toEqual({ stacks: [] });

    const gitignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('.git/dubstack');
  });

  it('returns already_exists and preserves data on second call', async () => {
    await init(dir);

    // Seed some data
    const statePath = path.join(dir, '.git', 'dubstack', 'state.json');
    const seeded = { stacks: [{ id: 'keep-me', branches: [] }] };
    fs.writeFileSync(statePath, JSON.stringify(seeded));

    const result = await init(dir);
    expect(result.status).toBe('already_exists');

    const loaded = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    expect(loaded.stacks[0].id).toBe('keep-me');
  });

  it('appends to existing gitignore without duplicating', async () => {
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n');

    await init(dir);
    const gitignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8');
    expect(gitignore).toBe('node_modules\n.git/dubstack\n');

    // Run again — should not duplicate
    await init(dir);
    const gitignoreAfter = fs.readFileSync(
      path.join(dir, '.gitignore'),
      'utf-8',
    );
    expect(gitignoreAfter).toBe('node_modules\n.git/dubstack\n');
  });

  it('handles gitignore without trailing newline', async () => {
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules');

    await init(dir);
    const gitignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8');
    expect(gitignore).toBe('node_modules\n.git/dubstack\n');
  });

  it('throws when not in a git repo', async () => {
    const tmpDir = await fs.promises.mkdtemp('/tmp/dubstack-nongit-');
    try {
      await expect(init(tmpDir)).rejects.toThrow(DubError);
    } finally {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
