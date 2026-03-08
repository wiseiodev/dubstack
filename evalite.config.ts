import * as fs from 'node:fs';
import * as path from 'node:path';
import { DB_LOCATION } from 'evalite/backend-only-constants';
import { defineConfig } from 'evalite/config';
import { createSqliteStorage } from 'evalite/sqlite-storage';

const databasePath = path.resolve(DB_LOCATION);

export default defineConfig({
  storage: async () => {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    return createSqliteStorage(databasePath);
  },
  scoreThreshold: 80,
  maxConcurrency: 1,
  testTimeout: 120_000,
});
