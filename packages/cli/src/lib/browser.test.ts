import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

import { execa } from 'execa';
import { openUrl } from './browser';

const mockExeca = execa as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockExeca.mockResolvedValue({ stdout: '' });
});

describe('openUrl', () => {
  it('uses open on macOS', async () => {
    await openUrl('https://dubstack.dev/docs', {
      platform: 'darwin',
    });

    expect(mockExeca).toHaveBeenCalledWith(
      'open',
      ['https://dubstack.dev/docs'],
      { stdio: 'ignore' },
    );
  });

  it('uses xdg-open on Linux', async () => {
    await openUrl('https://dubstack.dev/docs', {
      platform: 'linux',
    });

    expect(mockExeca).toHaveBeenCalledWith(
      'xdg-open',
      ['https://dubstack.dev/docs'],
      { stdio: 'ignore' },
    );
  });

  it('throws on unsupported platforms', async () => {
    await expect(
      openUrl('https://dubstack.dev/docs', {
        platform: 'freebsd',
      }),
    ).rejects.toThrow('Unsupported platform');
  });
});
