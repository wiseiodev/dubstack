import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

import { execa } from 'execa';
import { copyToClipboard } from './clipboard';

const mockExeca = execa as unknown as ReturnType<typeof vi.fn>;

const originalPlatform = process.platform;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value,
  });
}

beforeEach(() => {
  mockExeca.mockReset();
});

afterEach(() => {
  setPlatform(originalPlatform);
});

describe('copyToClipboard', () => {
  it('uses pbcopy on darwin and returns the tool name', async () => {
    setPlatform('darwin');
    mockExeca.mockResolvedValueOnce({ stdout: '', stderr: '' });
    const tool = await copyToClipboard('feat/auth');
    expect(tool).toBe('pbcopy');
    expect(mockExeca).toHaveBeenCalledWith('pbcopy', [], {
      input: 'feat/auth',
    });
  });

  it('returns null when no clipboard tool succeeds on linux', async () => {
    setPlatform('linux');
    mockExeca.mockRejectedValue(new Error('ENOENT'));
    const tool = await copyToClipboard('feat/auth');
    expect(tool).toBeNull();
    // wl-copy → xclip → xsel
    expect(mockExeca).toHaveBeenCalledTimes(3);
  });

  it('falls through to xclip when wl-copy is missing on linux', async () => {
    setPlatform('linux');
    mockExeca
      .mockRejectedValueOnce(new Error('ENOENT'))
      .mockResolvedValueOnce({ stdout: '', stderr: '' });
    const tool = await copyToClipboard('feat/auth');
    expect(tool).toBe('xclip');
  });

  it('uses clip on win32', async () => {
    setPlatform('win32');
    mockExeca.mockResolvedValueOnce({ stdout: '', stderr: '' });
    const tool = await copyToClipboard('feat/auth');
    expect(tool).toBe('clip');
  });

  it('never throws even when every candidate rejects', async () => {
    setPlatform('linux');
    mockExeca.mockRejectedValue(new Error('boom'));
    await expect(copyToClipboard('x')).resolves.toBeNull();
  });
});
