import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./exec', () => ({
  execa: vi.fn(),
}));

import { execa } from './exec';
import { notify } from './notify';

const execaMock = vi.mocked(execa);

afterEach(() => {
  execaMock.mockReset();
});

describe('notify', () => {
  it('shells out to osascript on darwin and escapes quotes', async () => {
    execaMock.mockResolvedValueOnce(undefined as never);
    const ok = await notify(
      { title: 'CI "passed"', message: 'PR #42' },
      { platform: 'darwin' },
    );
    expect(ok).toBe(true);
    expect(execaMock).toHaveBeenCalledWith(
      'osascript',
      ['-e', 'display notification "PR #42" with title "CI \\"passed\\""'],
      expect.objectContaining({ timeout: 5_000 }),
    );
  });

  it('uses notify-send on linux with -- to guard against title starting with -', async () => {
    execaMock.mockResolvedValueOnce(undefined as never);
    await notify(
      { title: '-fix CI broken', message: 'main moved 3 commits' },
      { platform: 'linux' },
    );
    // `--` terminates option parsing in notify-send so the `-fix` title
    // does not get interpreted as a flag.
    expect(execaMock).toHaveBeenCalledWith(
      'notify-send',
      ['--', '-fix CI broken', 'main moved 3 commits'],
      expect.objectContaining({ timeout: 5_000 }),
    );
  });

  it('returns false (does not throw) when the platform tool is missing', async () => {
    execaMock.mockRejectedValueOnce(new Error('ENOENT'));
    const ok = await notify(
      { title: 't', message: 'm' },
      { platform: 'darwin' },
    );
    expect(ok).toBe(false);
  });

  it('returns false on unsupported platforms', async () => {
    const ok = await notify(
      { title: 't', message: 'm' },
      { platform: 'freebsd' as NodeJS.Platform },
    );
    expect(ok).toBe(false);
    expect(execaMock).not.toHaveBeenCalled();
  });

  it('routes win32 through powershell -EncodedCommand with a base64 payload', async () => {
    execaMock.mockResolvedValueOnce(undefined as never);
    const ok = await notify(
      { title: 'PR #42', message: "branch'$evil" },
      { platform: 'win32' },
    );
    expect(ok).toBe(true);
    expect(execaMock).toHaveBeenCalledTimes(1);
    const call = execaMock.mock.calls[0] as unknown as [
      string,
      string[],
      Record<string, unknown>?,
    ];
    expect(call[0]).toBe('powershell');
    expect(call[1][0]).toBe('-NoProfile');
    expect(call[1][1]).toBe('-EncodedCommand');
    expect(typeof call[1][2]).toBe('string');
    // Decode the base64 UTF-16LE payload and verify the user content
    // appears only inside `[char]N+...` literals (no raw $ or backticks).
    const decoded = Buffer.from(call[1][2], 'base64').toString('utf16le');
    expect(decoded).toContain('ShowBalloonTip');
    // We use the `-join ''` form rather than `+`-concatenation so
    // PowerShell evaluates the literal as a string, not a numeric sum.
    expect(decoded).toContain('[char[]]');
    expect(decoded).toContain("-join ''");
    expect(decoded).not.toContain("'$evil");
  });

  it('refuses to dispatch when the title is empty (avoids broken notify-send output)', async () => {
    const ok = await notify(
      { title: '   ', message: 'body' },
      { platform: 'linux' },
    );
    expect(ok).toBe(false);
    expect(execaMock).not.toHaveBeenCalled();
  });

  it('passes a 5s timeout to the subprocess so a hung daemon cannot wedge the watcher', async () => {
    execaMock.mockResolvedValueOnce(undefined as never);
    await notify({ title: 't', message: 'm' }, { platform: 'darwin' });
    const call = execaMock.mock.calls[0] as unknown as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(call[2]).toEqual(expect.objectContaining({ timeout: 5_000 }));
  });
});
