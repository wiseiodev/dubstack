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
    expect(execaMock).toHaveBeenCalledWith('osascript', [
      '-e',
      'display notification "PR #42" with title "CI \\"passed\\""',
    ]);
  });

  it('uses notify-send on linux', async () => {
    execaMock.mockResolvedValueOnce(undefined as never);
    await notify(
      { title: 'Trunk advanced', message: 'main moved 3 commits' },
      { platform: 'linux' },
    );
    expect(execaMock).toHaveBeenCalledWith('notify-send', [
      'Trunk advanced',
      'main moved 3 commits',
    ]);
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
});
