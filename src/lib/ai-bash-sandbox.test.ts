import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestRepo } from '../../test/helpers';
import { createLocalBashSandbox } from './ai-bash-sandbox';

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

describe('createLocalBashSandbox', () => {
  it('executes shell commands inside the repository root', async () => {
    const sandbox = createLocalBashSandbox(dir);
    const result = await sandbox.executeCommand('pwd');
    const realDir = await fs.realpath(dir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(realDir);
  });

  it('blocks clearly destructive command patterns', async () => {
    const sandbox = createLocalBashSandbox(dir);
    const result = await sandbox.executeCommand('rm -rf .');

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('blocked for safety');
  });

  it('reads and writes files only within the repository root', async () => {
    const sandbox = createLocalBashSandbox(dir);
    await sandbox.writeFiles([
      { path: 'notes/a.txt', content: 'hello' },
      { path: `${dir}/notes/b.txt`, content: 'world' },
    ]);

    await expect(sandbox.readFile('notes/a.txt')).resolves.toBe('hello');
    await expect(sandbox.readFile(`${dir}/notes/b.txt`)).resolves.toBe('world');
    await expect(sandbox.readFile('../outside.txt')).rejects.toThrow(
      'outside the repository sandbox',
    );
  });
});
