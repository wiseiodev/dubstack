import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findNearbyTests, resolveVitestRunTarget } from './conflict-tests';

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
});
