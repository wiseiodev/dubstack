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
  __setGhRetryOptionsForTesting,
  checkGhAuth,
  createPr,
  enablePrAutoMerge,
  enqueuePrToMergeQueue,
  ensureGhInstalled,
  getAllPrSyncInfoBatch,
  getBranchMergeQueueStatus,
  getBranchPrLifecycleState,
  getBranchPrSyncInfo,
  getPr,
  getPrByNumber,
  getPrMergeStatusByNumber,
  getPrStateByNumber,
  getRepositoryWebUrl,
  getStackOverviewPrBatch,
  isPrAutoMergeEnabled,
  mergePr,
  openPrInBrowser,
  retargetPrBase,
  updatePrBody,
} from './github';

const mockExeca = execa as unknown as MockInstance;

beforeEach(() => {
  vi.clearAllMocks();
  // Disable backoff sleeps and jitter so retry tests don't burn wall-clock time.
  __setGhRetryOptionsForTesting({
    sleep: () => Promise.resolve(),
    random: () => 0,
  });
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

describe('getPrMergeStatusByNumber', () => {
  it('returns mergeability fields when present', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify({
        mergeable: 'CONFLICTING',
        mergeStateStatus: 'DIRTY',
      }),
    });
    await expect(getPrMergeStatusByNumber(5, '/repo')).resolves.toEqual({
      mergeable: 'CONFLICTING',
      mergeStateStatus: 'DIRTY',
    });
  });

  it('returns null fields when the PR is missing', async () => {
    mockExeca.mockRejectedValueOnce(
      new Error('GraphQL: Could not resolve to a PullRequest with the number'),
    );
    await expect(getPrMergeStatusByNumber(999999, '/repo')).resolves.toEqual({
      mergeable: null,
      mergeStateStatus: null,
    });
  });
});

describe('isPrAutoMergeEnabled', () => {
  it('returns true when autoMergeRequest is present', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify({ autoMergeRequest: { enabledAt: 'now' } }),
    });

    await expect(isPrAutoMergeEnabled(5, '/repo')).resolves.toBe(true);
  });

  it('returns false when autoMergeRequest is null', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify({ autoMergeRequest: null }),
    });

    await expect(isPrAutoMergeEnabled(5, '/repo')).resolves.toBe(false);
  });
});

describe('getAllPrSyncInfoBatch', () => {
  it('returns a map keyed by headRefName with classified state', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 1,
          headRefName: 'feat/a',
          baseRefName: 'main',
          state: 'OPEN',
          mergedAt: null,
        },
        {
          number: 2,
          headRefName: 'feat/b',
          baseRefName: 'feat/a',
          state: 'CLOSED',
          mergedAt: '2026-01-01T00:00:00Z',
        },
        {
          number: 3,
          headRefName: 'feat/c',
          baseRefName: 'main',
          state: 'CLOSED',
          mergedAt: null,
        },
      ]),
    });

    const result = await getAllPrSyncInfoBatch('/repo');

    expect(result.truncated).toBe(false);
    expect(result.byBranch.get('feat/a')).toEqual({
      state: 'OPEN',
      baseRefName: 'main',
    });
    expect(result.byBranch.get('feat/b')).toEqual({
      state: 'MERGED',
      baseRefName: 'feat/a',
    });
    expect(result.byBranch.get('feat/c')).toEqual({
      state: 'CLOSED',
      baseRefName: 'main',
    });
  });

  it('issues a single gh pr list call with only the fields BranchPrSyncInfo needs', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: '[]' });

    await getAllPrSyncInfoBatch('/repo');

    expect(mockExeca).toHaveBeenCalledTimes(1);
    expect(mockExeca).toHaveBeenCalledWith(
      'gh',
      [
        'pr',
        'list',
        '--state',
        'all',
        '--json',
        'headRefName,baseRefName,state,mergedAt',
        '--limit',
        '100',
      ],
      { cwd: '/repo' },
    );
  });

  it('returns an empty map when no PRs exist', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: '[]' });
    const result = await getAllPrSyncInfoBatch('/repo');
    expect(result.byBranch.size).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it('flags truncated when the page limit is hit', async () => {
    const entries = Array.from({ length: 100 }, (_, i) => ({
      number: i + 1,
      headRefName: `feat/${i}`,
      baseRefName: 'main',
      state: 'OPEN',
      mergedAt: null,
    }));
    mockExeca.mockResolvedValueOnce({ stdout: JSON.stringify(entries) });

    const result = await getAllPrSyncInfoBatch('/repo');

    expect(result.truncated).toBe(true);
    expect(result.byBranch.size).toBe(100);
  });

  it('keeps the first PR per branch when gh returns duplicates', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 5,
          headRefName: 'feat/a',
          baseRefName: 'main',
          state: 'OPEN',
          mergedAt: null,
        },
        {
          number: 4,
          headRefName: 'feat/a',
          baseRefName: 'main',
          state: 'CLOSED',
          mergedAt: '2026-01-01T00:00:00Z',
        },
      ]),
    });

    const result = await getAllPrSyncInfoBatch('/repo');

    expect(result.byBranch.get('feat/a')).toEqual({
      state: 'OPEN',
      baseRefName: 'main',
    });
  });

  it('throws a DubError when gh fails', async () => {
    mockExeca.mockRejectedValueOnce(new Error('network down'));
    await expect(getAllPrSyncInfoBatch('/repo')).rejects.toThrow(
      'Failed to list PRs',
    );
  });
});

describe('getStackOverviewPrBatch', () => {
  it('parses rich PR fields and rolls up CI status', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 11,
          title: 'feat: a',
          headRefName: 'feat/a',
          baseRefName: 'main',
          state: 'OPEN',
          mergedAt: null,
          reviewDecision: 'APPROVED',
          isDraft: false,
          statusCheckRollup: [
            { status: 'COMPLETED', conclusion: 'SUCCESS' },
            { status: 'COMPLETED', conclusion: 'SKIPPED' },
          ],
        },
        {
          number: 12,
          title: 'feat: b',
          headRefName: 'feat/b',
          baseRefName: 'feat/a',
          state: 'OPEN',
          mergedAt: null,
          reviewDecision: '',
          isDraft: true,
          statusCheckRollup: [
            { status: 'COMPLETED', conclusion: 'FAILURE' },
            { status: 'IN_PROGRESS' },
          ],
        },
      ]),
    });

    const result = await getStackOverviewPrBatch('/repo');

    expect(result.truncated).toBe(false);
    expect(result.byBranch.get('feat/a')).toEqual({
      number: 11,
      title: 'feat: a',
      state: 'OPEN',
      baseRefName: 'main',
      mergedAt: null,
      reviewDecision: 'APPROVED',
      ciRollup: 'SUCCESS',
      isDraft: false,
    });
    expect(result.byBranch.get('feat/b')).toEqual({
      number: 12,
      title: 'feat: b',
      state: 'OPEN',
      baseRefName: 'feat/a',
      mergedAt: null,
      reviewDecision: null,
      ciRollup: 'FAILURE',
      isDraft: true,
    });
  });

  it('issues exactly one gh pr list call with the richer field set', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: '[]' });
    await getStackOverviewPrBatch('/repo');
    expect(mockExeca).toHaveBeenCalledTimes(1);
    expect(mockExeca).toHaveBeenCalledWith(
      'gh',
      [
        'pr',
        'list',
        '--state',
        'all',
        '--json',
        'number,title,headRefName,baseRefName,state,mergedAt,reviewDecision,statusCheckRollup,isDraft',
        '--limit',
        '100',
      ],
      { cwd: '/repo' },
    );
  });

  it('rolls CI status up with FAILURE > PENDING > SUCCESS', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 1,
          title: 't',
          headRefName: 'pending',
          baseRefName: 'main',
          state: 'OPEN',
          mergedAt: null,
          reviewDecision: null,
          isDraft: false,
          statusCheckRollup: [
            { status: 'COMPLETED', conclusion: 'SUCCESS' },
            { status: 'QUEUED' },
          ],
        },
        {
          number: 2,
          title: 't',
          headRefName: 'success',
          baseRefName: 'main',
          state: 'OPEN',
          mergedAt: null,
          reviewDecision: null,
          isDraft: false,
          statusCheckRollup: [
            { status: 'COMPLETED', conclusion: 'NEUTRAL' },
            { state: 'SUCCESS' },
          ],
        },
        {
          number: 3,
          title: 't',
          headRefName: 'none',
          baseRefName: 'main',
          state: 'OPEN',
          mergedAt: null,
          reviewDecision: null,
          isDraft: false,
          statusCheckRollup: [],
        },
      ]),
    });

    const result = await getStackOverviewPrBatch('/repo');
    expect(result.byBranch.get('pending')?.ciRollup).toBe('PENDING');
    expect(result.byBranch.get('success')?.ciRollup).toBe('SUCCESS');
    expect(result.byBranch.get('none')?.ciRollup).toBe('NONE');
  });

  it('flags truncated when the page limit is hit', async () => {
    const entries = Array.from({ length: 100 }, (_, i) => ({
      number: i + 1,
      title: `pr-${i}`,
      headRefName: `feat/${i}`,
      baseRefName: 'main',
      state: 'OPEN',
      mergedAt: null,
      reviewDecision: null,
      isDraft: false,
      statusCheckRollup: [],
    }));
    mockExeca.mockResolvedValueOnce({ stdout: JSON.stringify(entries) });

    const result = await getStackOverviewPrBatch('/repo');
    expect(result.truncated).toBe(true);
    expect(result.byBranch.size).toBe(100);
  });

  it('keeps the first PR per branch when gh returns duplicates', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 9,
          title: 'newer',
          headRefName: 'feat/a',
          baseRefName: 'main',
          state: 'OPEN',
          mergedAt: null,
          reviewDecision: null,
          isDraft: false,
          statusCheckRollup: [],
        },
        {
          number: 8,
          title: 'older',
          headRefName: 'feat/a',
          baseRefName: 'main',
          state: 'CLOSED',
          mergedAt: '2026-01-01T00:00:00Z',
          reviewDecision: null,
          isDraft: false,
          statusCheckRollup: [],
        },
      ]),
    });

    const result = await getStackOverviewPrBatch('/repo');
    expect(result.byBranch.get('feat/a')?.number).toBe(9);
    expect(result.byBranch.get('feat/a')?.state).toBe('OPEN');
  });

  it('throws a DubError when gh fails', async () => {
    mockExeca.mockRejectedValueOnce(new Error('network down'));
    await expect(getStackOverviewPrBatch('/repo')).rejects.toThrow(
      'Failed to list PRs',
    );
  });

  it('skips records missing required number/title fields', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          // valid
          number: 1,
          title: 'feat: a',
          headRefName: 'feat/a',
          baseRefName: 'main',
          state: 'OPEN',
          mergedAt: null,
          reviewDecision: null,
          isDraft: false,
          statusCheckRollup: [],
        },
        {
          // missing number
          title: 'no number',
          headRefName: 'feat/no-number',
          baseRefName: 'main',
          state: 'OPEN',
          mergedAt: null,
          reviewDecision: null,
          isDraft: false,
          statusCheckRollup: [],
        },
        {
          // missing title
          number: 99,
          headRefName: 'feat/no-title',
          baseRefName: 'main',
          state: 'OPEN',
          mergedAt: null,
          reviewDecision: null,
          isDraft: false,
          statusCheckRollup: [],
        },
      ]),
    });

    const result = await getStackOverviewPrBatch('/repo');
    expect(result.byBranch.has('feat/a')).toBe(true);
    expect(result.byBranch.has('feat/no-number')).toBe(false);
    expect(result.byBranch.has('feat/no-title')).toBe(false);
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

describe('enablePrAutoMerge', () => {
  it('enables auto-merge with default squash strategy', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: '' });

    await expect(enablePrAutoMerge(44, '/repo')).resolves.toEqual({
      method: 'squash',
    });
    expect(mockExeca).toHaveBeenCalledWith(
      'gh',
      ['pr', 'merge', '44', '--auto', '--squash'],
      { cwd: '/repo', stdio: 'inherit' },
    );
  });

  it('passes through the requested merge method', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: '' });

    await expect(
      enablePrAutoMerge(44, '/repo', { method: 'rebase' }),
    ).resolves.toEqual({ method: 'rebase' });
    expect(mockExeca).toHaveBeenCalledWith(
      'gh',
      ['pr', 'merge', '44', '--auto', '--rebase'],
      { cwd: '/repo', stdio: 'inherit' },
    );
  });

  it('falls back when the preferred merge method is disabled', async () => {
    mockExeca
      .mockRejectedValueOnce(new Error('squash merge is disabled'))
      .mockResolvedValueOnce({ stdout: '' });

    await expect(enablePrAutoMerge(44, '/repo')).resolves.toEqual({
      method: 'merge',
    });
    expect(mockExeca).toHaveBeenNthCalledWith(
      1,
      'gh',
      ['pr', 'merge', '44', '--auto', '--squash'],
      { cwd: '/repo', stdio: 'inherit' },
    );
    expect(mockExeca).toHaveBeenNthCalledWith(
      2,
      'gh',
      ['pr', 'merge', '44', '--auto', '--merge'],
      { cwd: '/repo', stdio: 'inherit' },
    );
  });

  it('surfaces branch-protection setup failures with an actionable error', async () => {
    mockExeca.mockRejectedValueOnce(
      new Error(
        'Auto-merge is not available for pull requests without branch protection',
      ),
    );

    await expect(enablePrAutoMerge(44, '/repo')).rejects.toMatchObject({
      message: expect.stringContaining('Failed to enable auto-merge'),
      recovery: expect.arrayContaining([
        expect.stringContaining('branch protection'),
      ]),
    });
  });

  it('does not treat repository-level auto-merge setup failures as method fallback', async () => {
    mockExeca.mockRejectedValueOnce(
      new Error('Auto-merge is disabled for this repository'),
    );

    await expect(enablePrAutoMerge(44, '/repo')).rejects.toMatchObject({
      message: expect.stringContaining(
        'Auto-merge is disabled for this repository',
      ),
    });
    expect(mockExeca).toHaveBeenCalledTimes(1);
  });
});

describe('getBranchMergeQueueStatus', () => {
  it('returns true when branch protection includes required_merge_queue', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify({
        required_status_checks: { strict: true },
        required_merge_queue: { merge_method: 'SQUASH' },
      }),
    });

    await expect(getBranchMergeQueueStatus('main', '/repo')).resolves.toEqual({
      mergeQueueEnabled: true,
    });
    expect(mockExeca).toHaveBeenCalledWith(
      'gh',
      ['api', 'repos/{owner}/{repo}/branches/main/protection'],
      { cwd: '/repo' },
    );
  });

  it('returns false when branch protection has no merge queue', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify({
        required_status_checks: { strict: true },
        enforce_admins: { enabled: true },
      }),
    });

    await expect(getBranchMergeQueueStatus('main', '/repo')).resolves.toEqual({
      mergeQueueEnabled: false,
    });
  });

  it('returns false when branch protection is not enabled', async () => {
    mockExeca.mockRejectedValueOnce(new Error('HTTP 404: Not Found'));

    await expect(getBranchMergeQueueStatus('main', '/repo')).resolves.toEqual({
      mergeQueueEnabled: false,
    });
  });

  it('encodes branch names for the branch protection endpoint', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify({ required_merge_queue: {} }),
    });

    await getBranchMergeQueueStatus('release/next', '/repo');

    expect(mockExeca).toHaveBeenCalledWith(
      'gh',
      ['api', 'repos/{owner}/{repo}/branches/release%2Fnext/protection'],
      { cwd: '/repo' },
    );
  });
});

describe('enqueuePrToMergeQueue', () => {
  it('enables auto-merge with squash strategy for merge queue enrollment', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: '' });

    await expect(enqueuePrToMergeQueue(44, '/repo')).resolves.toBeUndefined();
    expect(mockExeca).toHaveBeenCalledWith(
      'gh',
      ['pr', 'merge', '44', '--auto', '--squash'],
      { cwd: '/repo', stdio: 'inherit' },
    );
  });

  it('surfaces enqueue failures with queue-specific recovery', async () => {
    mockExeca.mockRejectedValueOnce(new Error('merge queue disabled'));

    await expect(enqueuePrToMergeQueue(44, '/repo')).rejects.toMatchObject({
      message: expect.stringContaining(
        'Failed to enqueue PR #44 to the merge queue',
      ),
      recovery: expect.arrayContaining([
        expect.stringContaining('merge queue'),
      ]),
    });
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

describe('gh retry behavior', () => {
  it('retries getPr on transient failure and succeeds', async () => {
    mockExeca
      .mockRejectedValueOnce(new Error('502 Bad Gateway'))
      .mockRejectedValueOnce(new Error('network timeout'))
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 7,
          url: 'https://github.com/o/r/pull/7',
          title: 't',
          body: 'b',
        }),
      });

    const result = await getPr('feat/x', '/repo');

    expect(result).toEqual({
      number: 7,
      url: 'https://github.com/o/r/pull/7',
      title: 't',
      body: 'b',
    });
    expect(mockExeca).toHaveBeenCalledTimes(3);
  });

  it('short-circuits getPrByNumber on permanent 404', async () => {
    mockExeca.mockRejectedValue(new Error('HTTP 404: Not Found'));

    // 404 is permanent → only one attempt; isPrNotFoundError matches → null.
    await expect(getPrByNumber(123, '/repo')).resolves.toBeNull();
    expect(mockExeca).toHaveBeenCalledTimes(1);
  });

  it('short-circuits updatePrBody on permanent 403', async () => {
    mockExeca.mockRejectedValue(new Error('HTTP 403: Forbidden'));

    await expect(updatePrBody(42, '/tmp/body.md', '/repo')).rejects.toThrow(
      'permissions',
    );
    expect(mockExeca).toHaveBeenCalledTimes(1);
  });

  it('retries up to maxAttempts then wraps the failure', async () => {
    mockExeca.mockRejectedValue(new Error('502 Bad Gateway'));

    await expect(getBranchPrSyncInfo('feat/x', '/repo')).rejects.toThrow(
      /giving up after 4 attempts/,
    );
    expect(mockExeca).toHaveBeenCalledTimes(4);
  });

  it('retries mergePr on transient failure and succeeds', async () => {
    mockExeca
      .mockRejectedValueOnce(new Error('502 Bad Gateway'))
      .mockResolvedValueOnce({ stdout: '' });

    await expect(mergePr(99, '/repo')).resolves.toBeUndefined();
    expect(mockExeca).toHaveBeenCalledTimes(2);
  });

  it('does not classify bare HTTP-status digits in args as permanent', async () => {
    // Transient gh error whose stderr happens to echo a branch named "feat/404"
    // — the bare 404 must not short-circuit retries.
    mockExeca
      .mockRejectedValueOnce(
        new Error(
          'Command failed: gh pr list --head feat/404\n502 Bad Gateway',
        ),
      )
      .mockResolvedValueOnce({ stdout: 'null' });

    await expect(getPr('feat/404', '/repo')).resolves.toBeNull();
    expect(mockExeca).toHaveBeenCalledTimes(2);
  });
});

describe('createPr idempotency guard', () => {
  it('returns the existing PR when a phantom duplicate is detected on retry', async () => {
    const phantomUrl = 'https://github.com/o/r/pull/77';
    mockExeca
      // Attempt 1: gh pr create — succeeded server-side but the response was
      // lost to a transient network error.
      .mockRejectedValueOnce(new Error('502 Bad Gateway'))
      // Attempt 2 begins with getPr() (gh pr list) — returns the PR that the
      // first attempt actually created.
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 77,
          url: phantomUrl,
          title: 'feat: x',
          body: '',
        }),
      });

    const result = await createPr(
      'feat/x',
      'main',
      'feat: x',
      '/tmp/body.md',
      '/repo',
    );

    expect(result).toEqual({
      number: 77,
      url: phantomUrl,
      title: 'feat: x',
      body: '',
    });
    // Exactly two gh calls: the failed create + the idempotency check.
    expect(mockExeca).toHaveBeenCalledTimes(2);
    expect(mockExeca).toHaveBeenNthCalledWith(
      2,
      'gh',
      expect.arrayContaining(['pr', 'list', '--head', 'feat/x']),
      { cwd: '/repo' },
    );
  });

  it('retries createPr when no PR exists yet', async () => {
    mockExeca
      // Attempt 1: transient failure
      .mockRejectedValueOnce(new Error('502 Bad Gateway'))
      // Attempt 2: idempotency check finds no PR
      .mockResolvedValueOnce({ stdout: '' })
      // Attempt 2: gh pr create — succeeds
      .mockResolvedValueOnce({
        stdout: 'https://github.com/o/r/pull/88\n',
      });

    const result = await createPr(
      'feat/y',
      'main',
      'feat: y',
      '/tmp/body.md',
      '/repo',
    );

    expect(result.number).toBe(88);
    expect(mockExeca).toHaveBeenCalledTimes(3);
  });

  it('retries createPr if an unrelated PR title is found', async () => {
    mockExeca
      .mockRejectedValueOnce(new Error('502 Bad Gateway'))
      // Idempotency check returns a PR whose title does NOT match.
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 1,
          url: 'https://github.com/o/r/pull/1',
          title: 'something else',
          body: '',
        }),
      })
      .mockResolvedValueOnce({
        stdout: 'https://github.com/o/r/pull/2\n',
      });

    const result = await createPr(
      'feat/z',
      'main',
      'feat: z',
      '/tmp/body.md',
      '/repo',
    );

    expect(result.number).toBe(2);
    expect(mockExeca).toHaveBeenCalledTimes(3);
  });

  it('does not retry createPr on permanent 403', async () => {
    mockExeca.mockRejectedValueOnce(new Error('403 Forbidden'));

    await expect(
      createPr('feat/x', 'main', 't', '/tmp/body.md', '/repo'),
    ).rejects.toThrow('permissions');
    expect(mockExeca).toHaveBeenCalledTimes(1);
  });

  it('wraps the underlying error after exhausting createPr retries', async () => {
    mockExeca.mockRejectedValue(new Error('502 Bad Gateway'));

    await expect(
      createPr('feat/x', 'main', 'feat: x', '/tmp/body.md', '/repo'),
    ).rejects.toThrow(/Failed to create PR for 'feat\/x'.*502/);
    // At least one create attempt happened; exact call count depends on
    // the nested getPr retries and is intentionally not asserted.
    expect(mockExeca.mock.calls.length).toBeGreaterThanOrEqual(4);
  });
});
