import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export function writeTempMarkdownFile(prefix: string, content: string): string {
  const filePath = path.join(
    os.tmpdir(),
    `dubstack-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.md`,
  );
  fs.writeFileSync(filePath, content);
  return filePath;
}

export function removeTempFile(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Best-effort cleanup.
  }
}

export async function withTempMarkdownFile<T>(
  prefix: string,
  content: string,
  run: (filePath: string) => Promise<T>,
): Promise<T> {
  const filePath = writeTempMarkdownFile(prefix, content);
  try {
    return await run(filePath);
  } finally {
    removeTempFile(filePath);
  }
}
