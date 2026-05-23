import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProgress, resetProgressStateForTests } from '../progress';
import { printBranchOutcome } from './report';
import type { BranchSyncOutcome } from './types';

interface FakeStream {
  writes: string[];
  isTTY: boolean;
  write: (chunk: string | Uint8Array) => boolean;
  on: () => FakeStream;
  off: () => FakeStream;
  emit: () => boolean;
  cursorTo: () => boolean;
  clearLine: () => boolean;
  moveCursor: () => boolean;
  columns: number;
  rows: number;
}

function createFakeStream(isTTY: boolean): FakeStream {
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
  stream.on = (() => stream as FakeStream) as FakeStream['on'];
  stream.off = (() => stream as FakeStream) as FakeStream['off'];
  stream.emit = (() => true) as FakeStream['emit'];
  return stream as FakeStream;
}

describe('printBranchOutcome', () => {
  beforeEach(() => {
    resetProgressStateForTests();
  });

  afterEach(() => {
    resetProgressStateForTests();
    vi.restoreAllMocks();
  });

  const outcome: BranchSyncOutcome = {
    branch: 'feat/a',
    status: 'up-to-date',
    action: 'none',
    message: "• 'feat/a' is up to date.",
  };

  it('writes message to console without touching progress when none is active', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    printBranchOutcome(outcome);
    expect(log).toHaveBeenCalledWith("• 'feat/a' is up to date.");
  });

  it('pauses and resumes the active TTY progress around the print', () => {
    const stream = createFakeStream(true);
    const progress = createProgress({
      stream: stream as unknown as NodeJS.WriteStream,
      isTTY: true,
      ci: false,
    });
    progress.start('🔄 Reconciling', 3);
    const writesBefore = stream.writes.length;
    vi.spyOn(console, 'log').mockImplementation(() => {});

    printBranchOutcome(outcome);

    // pause stops the bar and resume re-renders it — both write to the stream.
    expect(stream.writes.length).toBeGreaterThan(writesBefore);
    progress.complete('🔄 Reconciling');
  });

  it('is a no-op for progress writes in non-TTY mode', () => {
    const stream = createFakeStream(false);
    const progress = createProgress({
      stream: stream as unknown as NodeJS.WriteStream,
      isTTY: false,
      ci: false,
    });
    progress.start('🔄 Reconciling', 3);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    printBranchOutcome(outcome);

    // Non-TTY progress is a no-op so it never writes to the stream.
    expect(stream.writes).toEqual([]);
  });
});
