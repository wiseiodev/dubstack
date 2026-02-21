import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestRepo } from '../../test/helpers';
import {
  clearRestackProgress,
  detectActiveOperation,
  getRestackProgressPath,
} from './operation-state';

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

describe('detectActiveOperation', () => {
  it('returns none when no operation is active', async () => {
    await expect(detectActiveOperation(dir)).resolves.toBe('none');
  });

  it('detects active git rebase', async () => {
    const rebaseDir = path.join(dir, '.git', 'rebase-merge');
    fs.mkdirSync(rebaseDir, { recursive: true });

    await expect(detectActiveOperation(dir)).resolves.toBe('rebase');
  });

  it('detects restack progress with higher priority than generic rebase', async () => {
    const progressPath = await getRestackProgressPath(dir);
    fs.mkdirSync(path.dirname(progressPath), { recursive: true });
    fs.writeFileSync(progressPath, '{}\n');
    const rebaseDir = path.join(dir, '.git', 'rebase-merge');
    fs.mkdirSync(rebaseDir, { recursive: true });

    await expect(detectActiveOperation(dir)).resolves.toBe('restack');
  });
});

describe('clearRestackProgress', () => {
  it('removes restack progress file when present', async () => {
    const progressPath = await getRestackProgressPath(dir);
    fs.mkdirSync(path.dirname(progressPath), { recursive: true });
    fs.writeFileSync(progressPath, '{}\n');

    await clearRestackProgress(dir);

    expect(fs.existsSync(progressPath)).toBe(false);
  });
});
