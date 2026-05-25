import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createConflictTestCache,
  findNearbyTests,
  resolveVitestRunTarget,
} from './conflict-tests';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dub-conflict-tests-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('findNearbyTests', () => {
  it('finds direct, sibling __tests__, and importing tests', () => {
    fs.mkdirSync(path.join(tmpDir, 'src', 'lib', '__tests__'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(tmpDir, 'test'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'lib', 'thing.ts'), '');
    fs.writeFileSync(path.join(tmpDir, 'src', 'lib', 'thing.test.ts'), '');
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'lib', '__tests__', 'thing-flow.test.ts'),
      '',
    );
    fs.writeFileSync(
      path.join(tmpDir, 'test', 'thing-import.test.ts'),
      "import { thing } from '../src/lib/thing';",
    );

    expect(findNearbyTests('src/lib/thing.ts', tmpDir)).toEqual([
      'src/lib/__tests__/thing-flow.test.ts',
      'src/lib/thing.test.ts',
      'test/thing-import.test.ts',
    ]);
  });

  it('caches scanned test files and contents across lookups', () => {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'test'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'thing.ts'), '');
    const importingTest = path.join(tmpDir, 'test', 'thing-import.test.ts');
    fs.writeFileSync(importingTest, "import { thing } from '../src/thing';");

    const cache = createConflictTestCache();
    const first = findNearbyTests('src/thing.ts', tmpDir, cache);
    fs.unlinkSync(importingTest);

    expect(findNearbyTests('src/thing.ts', tmpDir, cache)).toEqual(first);
    expect(findNearbyTests('src/thing.ts', tmpDir)).toEqual([]);
  });

  it('ignores non-TypeScript source files', () => {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'readme.md'), '');

    expect(findNearbyTests('src/readme.md', tmpDir)).toEqual([]);
  });

  it('runs tests from the nearest package that owns vitest', () => {
    fs.mkdirSync(path.join(tmpDir, 'packages', 'cli', 'src'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tmpDir, 'packages', 'cli', 'package.json'),
      JSON.stringify({
        scripts: {
          test: 'vitest run',
        },
      }),
    );
    fs.writeFileSync(
      path.join(tmpDir, 'packages', 'cli', 'src', 'thing.ts'),
      '',
    );

    expect(
      resolveVitestRunTarget(
        'packages/cli/src/thing.ts',
        ['packages/cli/src/thing.test.ts'],
        tmpDir,
      ),
    ).toEqual({
      cwd: path.join(tmpDir, 'packages', 'cli'),
      files: ['src/thing.test.ts'],
    });
  });

  it('falls back to the repo root when the conflicted file is missing', () => {
    expect(
      resolveVitestRunTarget(
        'packages/cli/src/missing.ts',
        ['packages/cli/src/missing.test.ts'],
        tmpDir,
      ),
    ).toEqual({
      cwd: tmpDir,
      files: ['packages/cli/src/missing.test.ts'],
    });
  });
});
