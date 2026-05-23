import {
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from 'vitest';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

import { execa } from 'execa';
import { DubError } from './errors';
import { fetchBranches, pushBranch } from './git';

const mockExeca = execa as unknown as MockInstance;

function gitError(
  stderr: string,
  exitCode = 128,
): Error & {
  stderr: string;
  exitCode: number;
} {
  const err = new Error(stderr) as Error & {
    stderr: string;
    exitCode: number;
  };
  err.stderr = stderr;
  err.exitCode = exitCode;
  return err;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('fetchBranches (retry)', () => {
  it('retries a transient failure and succeeds on the next attempt', async () => {
    mockExeca
      .mockRejectedValueOnce(
        gitError('fatal: unable to access: connection reset'),
      )
      .mockResolvedValueOnce({ stdout: '' });
    const onRetry = vi.fn();

    await expect(
      fetchBranches(['feat/a'], '/repo', 'origin', { onRetry }),
    ).resolves.toBeUndefined();

    expect(mockExeca).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(2, expect.any(Error));
  });

  it('throws immediately on authentication failure (no retry)', async () => {
    mockExeca.mockRejectedValueOnce(gitError('fatal: Authentication failed'));
    const onRetry = vi.fn();

    await expect(
      fetchBranches(['feat/a'], '/repo', 'origin', { onRetry }),
    ).rejects.toThrow(DubError);

    expect(mockExeca).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('throws immediately when the repository is not found', async () => {
    mockExeca.mockRejectedValueOnce(
      gitError('fatal: remote error: Repository not found'),
    );

    await expect(fetchBranches(['feat/a'], '/repo')).rejects.toThrow(DubError);
    expect(mockExeca).toHaveBeenCalledTimes(1);
  });

  it('skips missing remote refs without retrying or throwing', async () => {
    mockExeca.mockRejectedValueOnce(
      gitError("fatal: couldn't find remote ref refs/heads/feat/gone"),
    );

    await expect(
      fetchBranches(['feat/gone'], '/repo'),
    ).resolves.toBeUndefined();
    expect(mockExeca).toHaveBeenCalledTimes(1);
  });

  it('retries up to 4 attempts on persistent transient failure', async () => {
    mockExeca.mockRejectedValue(gitError('fatal: unable to access: timed out'));

    await expect(fetchBranches(['feat/a'], '/repo')).rejects.toThrow(DubError);
    expect(mockExeca).toHaveBeenCalledTimes(4);
  }, 10000);
});

describe('pushBranch (retry)', () => {
  it('retries a transient failure and succeeds on the next attempt', async () => {
    mockExeca
      .mockRejectedValueOnce(
        gitError('fatal: unable to access: connection reset'),
      )
      .mockResolvedValueOnce({ stdout: '' });
    const onRetry = vi.fn();

    await expect(
      pushBranch('feat/a', '/repo', { onRetry }),
    ).resolves.toBeUndefined();

    expect(mockExeca).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(2, expect.any(Error));
  });

  it('throws immediately on authentication failure', async () => {
    mockExeca.mockRejectedValueOnce(gitError('fatal: Authentication failed'));

    await expect(pushBranch('feat/a', '/repo')).rejects.toThrow(DubError);
    expect(mockExeca).toHaveBeenCalledTimes(1);
  });

  it('throws immediately on "Repository not found"', async () => {
    mockExeca.mockRejectedValueOnce(
      gitError('fatal: remote error: Repository not found'),
    );

    await expect(pushBranch('feat/a', '/repo')).rejects.toThrow(DubError);
    expect(mockExeca).toHaveBeenCalledTimes(1);
  });

  it('throws immediately when refusing to delete the current branch', async () => {
    mockExeca.mockRejectedValueOnce(
      gitError('fatal: refusing to delete the current branch: refs/heads/main'),
    );

    await expect(pushBranch('feat/a', '/repo')).rejects.toThrow(DubError);
    expect(mockExeca).toHaveBeenCalledTimes(1);
  });

  it('surfaces lease rejection as a DubError with dub-sync recovery hint', async () => {
    mockExeca.mockRejectedValueOnce(
      gitError(
        'To github.com:org/repo\n ! [rejected]   feat/a -> feat/a (stale info)\nerror: failed to push some refs',
      ),
    );

    let caught: DubError | null = null;
    try {
      await pushBranch('feat/a', '/repo');
    } catch (err) {
      caught = err as DubError;
    }

    expect(caught).toBeInstanceOf(DubError);
    expect(caught?.message).toMatch(/force-with-lease rejected/);
    expect(caught?.recovery.some((hint) => hint.includes('dub sync'))).toBe(
      true,
    );
    expect(mockExeca).toHaveBeenCalledTimes(1);
  });
});
