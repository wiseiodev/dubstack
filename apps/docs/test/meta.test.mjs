import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const metaPath = path.join(process.cwd(), 'content', 'docs', 'meta.json');

test('docs root page tree uses folder entries without separator duplicates', async () => {
  const meta = JSON.parse(await readFile(metaPath, 'utf8'));
  const separatorEntries = meta.pages.filter((entry) =>
    entry.startsWith('---'),
  );

  assert.deepEqual(separatorEntries, []);
});
