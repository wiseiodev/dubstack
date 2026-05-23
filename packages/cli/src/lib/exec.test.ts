import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execa } from './exec';
import { resetProgressStateForTests, setVerbose } from './progress';

describe('execa wrapper', () => {
  const originalWrite = process.stderr.write.bind(process.stderr);
  const writes: string[] = [];

  beforeEach(() => {
    resetProgressStateForTests();
    writes.length = 0;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(
        typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'),
      );
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    resetProgressStateForTests();
    process.stderr.write = originalWrite;
    setVerbose(false);
  });

  it('runs the subprocess without logging when verbose is off', async () => {
    const result = await execa('node', ['-e', 'process.stdout.write("ok")']);
    expect(result.stdout).toBe('ok');
    expect(writes.join('')).not.toContain('$ node');
  });

  it('prints the sanitized command line under verbose before running', async () => {
    setVerbose(true);
    await execa('node', [
      '-e',
      'process.stdout.write("ok")',
      'https://user:secret@example.com/repo.git',
    ]);
    const combined = writes.join('');
    expect(combined).toContain('$ node');
    expect(combined).toContain('[REDACTED]@example.com');
    expect(combined).not.toContain('secret');
  });
});
