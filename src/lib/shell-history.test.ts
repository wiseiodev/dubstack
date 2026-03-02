import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readRecentShellHistory } from './shell-history';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe('readRecentShellHistory', () => {
  it('parses zsh history and strips metadata prefixes', async () => {
    const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dub-zsh-'));
    tempDirs.push(home);
    await fs.promises.writeFile(
      path.join(home, '.zsh_history'),
      ": 1700000000:0;git status\n: 1700000001:0;dub ai ask 'hello'\n",
      'utf8',
    );

    const entries = await readRecentShellHistory({
      homeDir: home,
      shell: '/bin/zsh',
      maxCommands: 20,
    });

    expect(entries).toEqual(['git status', "dub ai ask 'hello'"]);
  });

  it('parses bash history and returns bounded recent lines', async () => {
    const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dub-bash-'));
    tempDirs.push(home);
    await fs.promises.writeFile(
      path.join(home, '.bash_history'),
      'echo one\necho two\necho three\n',
      'utf8',
    );

    const entries = await readRecentShellHistory({
      homeDir: home,
      shell: '/bin/bash',
      maxCommands: 2,
    });

    expect(entries).toEqual(['echo two', 'echo three']);
  });

  it('redacts sensitive fragments in captured history', async () => {
    const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dub-red-'));
    tempDirs.push(home);
    await fs.promises.writeFile(
      path.join(home, '.zsh_history'),
      [
        ': 1700000000:0;export DUBSTACK_GEMINI_API_KEY=abc123',
        ': 1700000001:0;curl -H "Authorization: Bearer super-secret"',
      ].join('\n'),
      'utf8',
    );

    const entries = await readRecentShellHistory({
      homeDir: home,
      shell: '/bin/zsh',
      maxCommands: 20,
    });

    expect(entries.join('\n')).toContain('[REDACTED]');
    expect(entries.join('\n')).not.toContain('abc123');
    expect(entries.join('\n')).not.toContain('super-secret');
  });

  it('reads recent lines from large history files', async () => {
    const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dub-big-'));
    tempDirs.push(home);
    const lines = Array.from({ length: 20000 }, (_, i) => `echo line-${i + 1}`);
    await fs.promises.writeFile(
      path.join(home, '.bash_history'),
      `${lines.join('\n')}\n`,
      'utf8',
    );

    const entries = await readRecentShellHistory({
      homeDir: home,
      shell: '/bin/bash',
      maxCommands: 3,
    });

    expect(entries).toEqual([
      'echo line-19998',
      'echo line-19999',
      'echo line-20000',
    ]);
  });
});
