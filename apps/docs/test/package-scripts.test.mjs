import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const packageJsonPath = path.join(process.cwd(), 'package.json');

test('docs package exposes clean restart scripts for stale Next build output', async () => {
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));

  assert.equal(
    typeof packageJson.scripts.clean,
    'string',
    'expected docs package to define a clean script',
  );
  assert.equal(
    typeof packageJson.scripts['dev:clean'],
    'string',
    'expected docs package to define a dev:clean script',
  );
});
