import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./doctor.js', () => ({
  doctor: vi.fn(),
}));

vi.mock('./submit.js', () => ({
  getSubmitPlan: vi.fn(),
}));

import { doctor } from './doctor';
import { ready } from './ready';
import { getSubmitPlan } from './submit';

const mockDoctor = doctor as ReturnType<typeof vi.fn>;
const mockGetSubmitPlan = getSubmitPlan as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ready', () => {
  it('is ready when doctor is clean and submit preflight succeeds', async () => {
    mockDoctor.mockResolvedValue({
      healthy: true,
      issues: [],
      checkedBranch: 'feat/a',
    });
    mockGetSubmitPlan.mockResolvedValue({
      currentBranch: 'feat/a',
      rootBranch: 'main',
      path: 'current',
      branches: [
        { name: 'feat/a', parent: 'main', pr_number: null, pr_link: null },
      ],
    });

    const result = await ready('/repo');
    expect(result.ready).toBe(true);
    expect(result.submitBranches).toEqual(['feat/a']);
    expect(result.blockers).toEqual([]);
  });

  it('is not ready when doctor reports issues', async () => {
    mockDoctor.mockResolvedValue({
      healthy: false,
      issues: [
        {
          code: 'operation-in-progress',
          summary: 'restack in progress',
          details: 'run continue/abort',
          fixes: ['dub continue', 'dub abort'],
        },
      ],
      checkedBranch: 'feat/a',
    });
    mockGetSubmitPlan.mockResolvedValue({
      currentBranch: 'feat/a',
      rootBranch: 'main',
      path: 'current',
      branches: [
        { name: 'feat/a', parent: 'main', pr_number: null, pr_link: null },
      ],
    });

    const result = await ready('/repo');
    expect(result.ready).toBe(false);
    expect(result.blockers).toContain('operation-in-progress');
  });

  it('is not ready when submit preflight fails', async () => {
    mockDoctor.mockResolvedValue({
      healthy: true,
      issues: [],
      checkedBranch: 'feat/a',
    });
    mockGetSubmitPlan.mockRejectedValue(
      new Error('Cannot submit from a root branch'),
    );

    const result = await ready('/repo');
    expect(result.ready).toBe(false);
    expect(result.blockers).toContain('submit-preflight');
  });
});
