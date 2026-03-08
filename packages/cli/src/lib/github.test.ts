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
import {
  checkGhAuth,
  createPr,
  ensureGhInstalled,
  getBranchPrLifecycleState,
  getBranchPrSyncInfo,
  getPr,
  getPrByNumber,
  getPrStateByNumber,
  getRepositoryWebUrl,
  mergePr,
  openPrInBrowser,
  retargetPrBase,
  updatePrBody,
} from './github';

const mockExeca = execa as unknown as MockInstance;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ensureGhInstalled', () => {
  it('resolves when gh is found', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: 'gh version 2.0.0' });
    await expect(ensureGhInstalled()).resolves.toBeUndefined();
  });

  it('throws DubError when gh is not found', async () => {
    mockExeca.mockRejectedValue(new Error('not found'));
    await expect(ensureGhInstalled()).rejects.toThrow('gh CLI not found');
  });
});

describe('checkGhAuth', () => {
  it('resolves when authenticated', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: '' });
    await expect(checkGhAuth()).resolves.toBeUndefined();
  });

  it('throws DubError when not authenticated', async () => {
    mockExeca.mockRejectedValue(new Error('not logged in'));
    await expect(checkGhAuth()).rejects.toThrow('Not authenticated');
  });
});

describe('getPr', () => {
  it('returns PrInfo when PR exists', async () => {
    const prJson = JSON.stringify({
      number: 42,
      url: 'https://github.com/o/r/pull/42',
      title: 'feat: thing',
      body: 'description',
    });
    mockExeca.mockResolvedValueOnce({ stdout: prJson });

    const result = await getPr('feat/thing', '/repo');

    expect(result).toEqual({
      number: 42,
      url: 'https://github.com/o/r/pull/42',
      title: 'feat: thing',
      body: 'description',
    });
  });

  it('returns null when no PR exists', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: '' });
    expect(await getPr('no-pr', '/repo')).toBeNull();
  });

  it('returns null when jq returns null', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: 'null' });
    expect(await getPr('no-pr', '/repo')).toBeNull();
  });
});

describe('getPrByNumber', () => {
  it('returns PrInfo by number', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 12,
        url: 'https://github.com/o/r/pull/12',
        title: 'feat: b',
        body: 'body',
      }),
    });
    await expect(getPrByNumber(12, '/repo')).resolves.toEqual({
      number: 12,
      url: 'https://github.com/o/r/pull/12',
      title: 'feat: b',
      body: 'body',
    });
  });

  it('returns null when PR number does not exist', async () => {
    mockExeca.mockRejectedValueOnce(
      new Error('GraphQL: Could not resolve to a PullRequest with the number'),
    );
    await expect(getPrByNumber(999999, '/repo')).resolves.toBeNull();
  });
});

describe('getBranchPrLifecycleState', () => {
  it('returns NONE when no PR exists', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: 'null' });
    await expect(getBranchPrLifecycleState('feat/a', '/repo')).resolves.toBe(
      'NONE',
    );
  });

  it('returns MERGED when mergedAt is present', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify({
        state: 'CLOSED',
        mergedAt: '2026-01-01T00:00:00Z',
      }),
    });
    await expect(getBranchPrLifecycleState('feat/a', '/repo')).resolves.toBe(
      'MERGED',
    );
  });

  it('returns CLOSED/OPEN from state', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify({ state: 'CLOSED', mergedAt: null }),
    });
    await expect(getBranchPrLifecycleState('feat/a', '/repo')).resolves.toBe(
      'CLOSED',
    );

    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify({ state: 'OPEN', mergedAt: null }),
    });
    await expect(getBranchPrLifecycleState('feat/a', '/repo')).resolves.toBe(
      'OPEN',
    );
  });
});

describe('getPrStateByNumber', () => {
  it('returns MERGED when mergedAt is present', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify({
        state: 'CLOSED',
        mergedAt: '2026-01-01T00:00:00Z',
      }),
    });
    await expect(getPrStateByNumber(5, '/repo')).resolves.toBe('MERGED');
  });

  it('returns OPEN/CLOSED from state', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify({ state: 'OPEN', mergedAt: null }),
    });
    await expect(getPrStateByNumber(5, '/repo')).resolves.toBe('OPEN');

    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify({ state: 'CLOSED', mergedAt: null }),
    });
    await expect(getPrStateByNumber(5, '/repo')).resolves.toBe('CLOSED');
  });

  it('returns NONE when PR number does not exist', async () => {
    mockExeca.mockRejectedValueOnce(
      new Error('GraphQL: Could not resolve to a PullRequest with the number'),
    );
    await expect(getPrStateByNumber(999999, '/repo')).resolves.toBe('NONE');
  });
});

describe('getBranchPrSyncInfo', () => {
  it('returns baseRefName when present', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify({
        state: 'OPEN',
        mergedAt: null,
        baseRefName: 'main',
      }),
    });
    await expect(getBranchPrSyncInfo('feat/a', '/repo')).resolves.toEqual({
      state: 'OPEN',
      baseRefName: 'main',
    });
  });
});

describe('createPr', () => {
  it('parses PR number from stdout URL', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: 'https://github.com/o/r/pull/99\n',
    });

    const result = await createPr(
      'feat/x',
      'main',
      'title',
      '/tmp/body.md',
      '/repo',
    );

    expect(result.number).toBe(99);
    expect(result.url).toBe('https://github.com/o/r/pull/99');
  });

  it('throws descriptive error on 403', async () => {
    mockExeca.mockRejectedValueOnce(new Error('403 Forbidden'));

    await expect(
      createPr('feat/x', 'main', 'title', '/tmp/body.md', '/repo'),
    ).rejects.toThrow('permissions');
  });

  it('throws on unexpected output', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: 'something unexpected' });

    await expect(
      createPr('feat/x', 'main', 'title', '/tmp/body.md', '/repo'),
    ).rejects.toThrow('Unexpected output');
  });
});

describe('updatePrBody', () => {
  it('calls gh pr edit with correct args', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: '' });

    await updatePrBody(42, '/tmp/body.md', '/repo');

    expect(mockExeca).toHaveBeenCalledWith(
      'gh',
      ['pr', 'edit', '42', '--body-file', '/tmp/body.md'],
      { cwd: '/repo' },
    );
  });

  it('throws descriptive error on 403', async () => {
    mockExeca.mockRejectedValueOnce(new Error('403 insufficient scope'));

    await expect(updatePrBody(42, '/tmp/body.md', '/repo')).rejects.toThrow(
      'permissions',
    );
  });
});

describe('retargetPrBase', () => {
  it('calls gh pr edit --base', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: '' });
    await retargetPrBase('feat/a', 'main', '/repo');
    expect(mockExeca).toHaveBeenCalledWith(
      'gh',
      ['pr', 'edit', 'feat/a', '--base', 'main'],
      { cwd: '/repo' },
    );
  });
});

describe('mergePr', () => {
  it('merges with default --merge and delete-branch', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: '' });
    await mergePr(44, '/repo');
    expect(mockExeca).toHaveBeenCalledWith(
      'gh',
      ['pr', 'merge', '44', '--merge', '--delete-branch'],
      { cwd: '/repo', stdio: 'inherit' },
    );
  });

  it('supports squash strategy', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: '' });
    await mergePr(44, '/repo', { method: 'squash', deleteBranch: false });
    expect(mockExeca).toHaveBeenCalledWith(
      'gh',
      ['pr', 'merge', '44', '--squash'],
      { cwd: '/repo', stdio: 'inherit' },
    );
  });
});

describe('openPrInBrowser', () => {
  it('opens current branch PR in browser when no target is provided', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: '' });
    await openPrInBrowser('/repo');
    expect(mockExeca).toHaveBeenCalledWith('gh', ['pr', 'view', '--web'], {
      cwd: '/repo',
      stdio: 'inherit',
    });
  });

  it('opens the PR for the provided branch/number target', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: '' });
    await openPrInBrowser('/repo', 'feat/a');
    expect(mockExeca).toHaveBeenCalledWith(
      'gh',
      ['pr', 'view', 'feat/a', '--web'],
      { cwd: '/repo', stdio: 'inherit' },
    );
  });
});

describe('getRepositoryWebUrl', () => {
  it('uses the upstream remote when available', async () => {
    mockExeca
      .mockResolvedValueOnce({ stdout: 'origin/feat/a' })
      .mockResolvedValueOnce({
        stdout: 'git@github.com:wiseiodev/dubstack.git',
      });

    await expect(getRepositoryWebUrl('/repo')).resolves.toBe(
      'https://github.com/wiseiodev/dubstack',
    );
    expect(mockExeca).toHaveBeenNthCalledWith(
      1,
      'git',
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
      { cwd: '/repo' },
    );
    expect(mockExeca).toHaveBeenNthCalledWith(
      2,
      'git',
      ['remote', 'get-url', 'origin'],
      { cwd: '/repo' },
    );
  });

  it('falls back to origin when the current branch has no upstream', async () => {
    mockExeca
      .mockRejectedValueOnce(new Error('no upstream configured'))
      .mockResolvedValueOnce({
        stdout: 'https://github.com/wiseiodev/dubstack.git',
      });

    await expect(getRepositoryWebUrl('/repo')).resolves.toBe(
      'https://github.com/wiseiodev/dubstack',
    );
    expect(mockExeca).toHaveBeenNthCalledWith(
      2,
      'git',
      ['remote', 'get-url', 'origin'],
      { cwd: '/repo' },
    );
  });

  it('accepts ssh:// GitHub remotes', async () => {
    mockExeca
      .mockRejectedValueOnce(new Error('no upstream configured'))
      .mockResolvedValueOnce({
        stdout: 'ssh://git@github.com/wiseiodev/dubstack.git',
      });

    await expect(getRepositoryWebUrl('/repo')).resolves.toBe(
      'https://github.com/wiseiodev/dubstack',
    );
  });

  it('throws for non-GitHub remotes', async () => {
    mockExeca
      .mockRejectedValueOnce(new Error('no upstream configured'))
      .mockResolvedValueOnce({
        stdout: 'git@gitlab.com:wiseiodev/dubstack.git',
      });

    await expect(getRepositoryWebUrl('/repo')).rejects.toThrow(
      'does not point to GitHub',
    );
  });
});
