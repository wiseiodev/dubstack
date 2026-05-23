import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createProgress,
  formatVerboseCommandLine,
  getActiveProgress,
  isVerbose,
  logVerboseCommand,
  resetProgressStateForTests,
  setVerbose,
} from './progress';

interface FakeStream {
  writes: string[];
  isTTY: boolean;
  write: (chunk: string | Uint8Array) => boolean;
  on: (event: string, listener: (...args: unknown[]) => void) => FakeStream;
  off: (event: string, listener: (...args: unknown[]) => void) => FakeStream;
  emit: (event: string, ...args: unknown[]) => boolean;
  cursorTo: () => boolean;
  clearLine: () => boolean;
  moveCursor: () => boolean;
  columns: number;
  rows: number;
}

function createFakeStream(isTTY: boolean): FakeStream {
  const emitter = new EventEmitter();
  const stream: Partial<FakeStream> = {
    writes: [],
    isTTY,
    columns: 80,
    rows: 24,
    write(chunk) {
      const value =
        typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      this.writes?.push(value);
      return true;
    },
    cursorTo: () => true,
    clearLine: () => true,
    moveCursor: () => true,
  };
  stream.on = ((event, listener) => {
    emitter.on(event, listener);
    return stream as FakeStream;
  }) as FakeStream['on'];
  stream.off = ((event, listener) => {
    emitter.off(event, listener);
    return stream as FakeStream;
  }) as FakeStream['off'];
  stream.emit = ((event, ...args) =>
    emitter.emit(event, ...args)) as FakeStream['emit'];
  return stream as FakeStream;
}

describe('createProgress', () => {
  beforeEach(() => {
    resetProgressStateForTests();
  });

  afterEach(() => {
    resetProgressStateForTests();
  });

  it('returns a no-op progress when not in a TTY', () => {
    const stream = createFakeStream(false);
    const progress = createProgress({
      stream: stream as unknown as NodeJS.WriteStream,
      isTTY: false,
      ci: false,
    });

    progress.start('downloading', 5);
    progress.update('downloading', 2, 'a.txt');
    progress.complete('downloading');

    expect(stream.writes).toEqual([]);
    expect(getActiveProgress()).toBeNull();
  });

  it('returns a no-op progress when CI is detected', () => {
    const stream = createFakeStream(true);
    const progress = createProgress({
      stream: stream as unknown as NodeJS.WriteStream,
      isTTY: true,
      ci: true,
    });

    progress.start('downloading', 5);
    progress.update('downloading', 1);
    progress.complete('downloading');

    expect(stream.writes).toEqual([]);
  });

  it('renders progress to the TTY stream and tracks active progress', () => {
    const stream = createFakeStream(true);
    const progress = createProgress({
      stream: stream as unknown as NodeJS.WriteStream,
      isTTY: true,
      ci: false,
    });

    progress.start('restacking', 3);
    expect(getActiveProgress()).toBe(progress);
    expect(stream.writes.length).toBeGreaterThan(0);

    progress.update('restacking', 1, 'feat/a');
    progress.update('restacking', 2, 'feat/b');
    progress.complete('restacking');

    expect(getActiveProgress()).toBeNull();
    const combined = stream.writes.join('');
    expect(combined).toContain('restacking');
  });

  it('pause clears output and resume resumes rendering', () => {
    const stream = createFakeStream(true);
    const progress = createProgress({
      stream: stream as unknown as NodeJS.WriteStream,
      isTTY: true,
      ci: false,
    });

    progress.start('pushing', 4);
    progress.update('pushing', 2, 'feat/a');
    const writesBeforePause = stream.writes.length;
    progress.pause();
    const writesAfterPause = stream.writes.length;
    expect(writesAfterPause).toBeGreaterThanOrEqual(writesBeforePause);

    progress.update('pushing', 3, 'feat/b');
    const writesAfterUpdateWhilePaused = stream.writes.length;
    expect(writesAfterUpdateWhilePaused).toBe(writesAfterPause);

    progress.resume();
    expect(stream.writes.length).toBeGreaterThan(writesAfterUpdateWhilePaused);

    progress.complete('pushing');
    expect(getActiveProgress()).toBeNull();
  });

  it('uses an indeterminate format when total is omitted', () => {
    const stream = createFakeStream(true);
    const progress = createProgress({
      stream: stream as unknown as NodeJS.WriteStream,
      isTTY: true,
      ci: false,
    });

    progress.start('scanning');
    progress.update('scanning', 3, 'feat/c');
    progress.complete('scanning');

    const combined = stream.writes.join('');
    expect(combined).toContain('scanning');
    // Indeterminate mode should never render the "{value}/{total}" pair as 0/0
    expect(combined).not.toMatch(/\b0\/0\b/);
  });

  it('stop halts the bar without forcing it to 100% and clears active progress', () => {
    const stream = createFakeStream(true);
    const progress = createProgress({
      stream: stream as unknown as NodeJS.WriteStream,
      isTTY: true,
      ci: false,
    });

    progress.start('working', 10);
    progress.update('working', 3, 'feat/a');
    expect(getActiveProgress()).toBe(progress);
    progress.stop();

    expect(getActiveProgress()).toBeNull();
    expect(() => progress.stop()).not.toThrow();
  });

  it('pause is a no-op when already paused or not started', () => {
    const stream = createFakeStream(true);
    const progress = createProgress({
      stream: stream as unknown as NodeJS.WriteStream,
      isTTY: true,
      ci: false,
    });

    expect(() => progress.pause()).not.toThrow();
    expect(() => progress.resume()).not.toThrow();

    progress.start('idle', 1);
    progress.pause();
    expect(() => progress.pause()).not.toThrow();
    progress.complete('idle');
  });
});

describe('verbose flag plumbing', () => {
  beforeEach(() => {
    resetProgressStateForTests();
  });

  afterEach(() => {
    resetProgressStateForTests();
  });

  it('setVerbose toggles isVerbose', () => {
    expect(isVerbose()).toBe(false);
    setVerbose(true);
    expect(isVerbose()).toBe(true);
    setVerbose(false);
    expect(isVerbose()).toBe(false);
  });

  it('logVerboseCommand is a no-op when verbose is off', () => {
    const stream = createFakeStream(false);
    setVerbose(false);
    logVerboseCommand('git', ['status'], {
      stream: stream as unknown as NodeJS.WriteStream,
      progress: null,
    });
    expect(stream.writes).toEqual([]);
  });

  it('logVerboseCommand writes a sanitized command line when verbose is on', () => {
    const stream = createFakeStream(false);
    setVerbose(true);
    logVerboseCommand(
      'git',
      ['push', 'https://oauth2:secret@github.com/foo/bar.git', 'feat/a'],
      {
        stream: stream as unknown as NodeJS.WriteStream,
        progress: null,
      },
    );

    expect(stream.writes.length).toBe(1);
    const line = stream.writes[0];
    expect(line.startsWith('$ git push ')).toBe(true);
    expect(line).toContain('[REDACTED]@github.com');
    expect(line).not.toContain('secret');
    expect(line.endsWith('\n')).toBe(true);
  });

  it('logVerboseCommand pauses and resumes the supplied progress around the write', () => {
    const events: string[] = [];
    const progress = {
      start: () => {},
      update: () => {},
      complete: () => {},
      pause: () => {
        events.push('pause');
      },
      resume: () => {
        events.push('resume');
      },
      stop: () => {},
    };
    const stream = createFakeStream(false);
    setVerbose(true);

    logVerboseCommand('gh', ['pr', 'view'], {
      stream: stream as unknown as NodeJS.WriteStream,
      progress,
    });

    expect(events).toEqual(['pause', 'resume']);
    expect(stream.writes).toEqual(['$ gh pr view\n']);
  });

  it('logVerboseCommand falls back to the active progress when none is supplied', () => {
    const ttyStream = createFakeStream(true);
    const progress = createProgress({
      stream: ttyStream as unknown as NodeJS.WriteStream,
      isTTY: true,
      ci: false,
    });
    progress.start('working', 5);
    expect(getActiveProgress()).toBe(progress);

    const writesBefore = ttyStream.writes.length;
    setVerbose(true);
    const logStream = createFakeStream(false);
    logVerboseCommand('git', ['fetch'], {
      stream: logStream as unknown as NodeJS.WriteStream,
    });

    expect(logStream.writes).toEqual(['$ git fetch\n']);
    // pause stops the bar, resume re-renders it — both should touch the TTY stream
    expect(ttyStream.writes.length).toBeGreaterThan(writesBefore);

    progress.complete('working');
  });
});

describe('formatVerboseCommandLine', () => {
  it('prefixes with $ and joins args', () => {
    expect(formatVerboseCommandLine('git', ['status'])).toBe('$ git status');
  });

  it('sanitizes basic-auth credentials in https URLs', () => {
    const line = formatVerboseCommandLine('git', [
      'clone',
      'https://user:token@github.com/x/y.git',
    ]);
    expect(line).toBe('$ git clone https://[REDACTED]@github.com/x/y.git');
  });

  it('sanitizes token query parameters in URLs', () => {
    const line = formatVerboseCommandLine('curl', [
      'https://api.example.com/repos?token=abc123&page=1',
    ]);
    expect(line).toContain('token=[REDACTED]');
    expect(line).not.toContain('abc123');
    expect(line).toContain('page=1');
  });

  it('leaves non-URL args untouched', () => {
    const line = formatVerboseCommandLine('git', [
      'commit',
      '-m',
      'fix: oauth2:secret@in:commit message',
    ]);
    expect(line).toContain('oauth2:secret@in:commit message');
  });
});
