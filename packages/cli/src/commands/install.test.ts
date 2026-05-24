import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestRepo } from '../../test/helpers';
import { DubError } from '../lib/errors';
import { install, RETARGET_ACTION_TEMPLATE } from './install';

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

describe('install retarget-action', () => {
  it('writes the workflow file into .github/workflows/', async () => {
    const result = await install(dir, 'retarget-action');
    expect(result.status).toBe('installed');
    expect(result.path).toMatch(/\.github\/workflows\/dubstack-retarget\.yml$/);
    expect(fs.existsSync(result.path)).toBe(true);
    expect(fs.readFileSync(result.path, 'utf-8')).toBe(
      RETARGET_ACTION_TEMPLATE,
    );
  });

  it('returns already-installed when content matches', async () => {
    await install(dir, 'retarget-action');
    const result = await install(dir, 'retarget-action');
    expect(result.status).toBe('already-installed');
  });

  it('--dry-run does not touch disk', async () => {
    const result = await install(dir, 'retarget-action', { dryRun: true });
    expect(result.status).toBe('preview');
    if (result.status !== 'preview') return;
    expect(result.content).toBe(RETARGET_ACTION_TEMPLATE);
    expect(
      fs.existsSync(path.join(dir, '.github/workflows/dubstack-retarget.yml')),
    ).toBe(false);
  });

  it('cancels when confirm returns false on a content diff', async () => {
    const target = path.join(dir, '.github/workflows/dubstack-retarget.yml');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'old content\n');

    const result = await install(dir, 'retarget-action', {
      confirm: async () => false,
    });
    expect(result.status).toBe('cancelled');
    expect(fs.readFileSync(target, 'utf-8')).toBe('old content\n');
  });

  it('overwrites when confirm returns true on a content diff', async () => {
    const target = path.join(dir, '.github/workflows/dubstack-retarget.yml');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'old content\n');

    const result = await install(dir, 'retarget-action', {
      confirm: async () => true,
    });
    expect(result.status).toBe('overwritten');
    expect(fs.readFileSync(target, 'utf-8')).toBe(RETARGET_ACTION_TEMPLATE);
  });

  it('--force overwrites without prompting', async () => {
    const target = path.join(dir, '.github/workflows/dubstack-retarget.yml');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'old content\n');

    let confirmCalled = false;
    const result = await install(dir, 'retarget-action', {
      force: true,
      confirm: async () => {
        confirmCalled = true;
        return false;
      },
    });
    expect(result.status).toBe('overwritten');
    expect(confirmCalled).toBe(false);
    expect(fs.readFileSync(target, 'utf-8')).toBe(RETARGET_ACTION_TEMPLATE);
  });

  it('throws DubError when not in a git repo', async () => {
    const tmpDir = await fs.promises.mkdtemp('/tmp/dubstack-nongit-');
    try {
      await expect(install(tmpDir, 'retarget-action')).rejects.toThrow(
        DubError,
      );
    } finally {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('embedded template matches the on-disk YAML source-of-truth', async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const onDisk = await fs.promises.readFile(
      path.join(here, '..', 'templates', 'retarget-action.yml'),
      'utf-8',
    );
    expect(onDisk).toBe(RETARGET_ACTION_TEMPLATE);
  });
});
