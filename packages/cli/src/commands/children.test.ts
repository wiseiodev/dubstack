import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getCurrentBranch } from '../lib/git';
import { readState } from '../lib/state';
import { children } from './children';

vi.mock('../lib/git');
vi.mock('../lib/state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/state')>();
  return {
    ...actual,
    readState: vi.fn(),
  };
});

describe('children command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns children for tracked branch', async () => {
    vi.mocked(getCurrentBranch).mockResolvedValue('main');
    vi.mocked(readState).mockResolvedValue({
      stacks: [
        {
          id: 'stack-1',
          branches: [
            {
              name: 'main',
              type: 'root',
              parent: null,
              pr_number: null,
              pr_link: null,
            },
            {
              name: 'feat/b',
              parent: 'main',
              pr_number: null,
              pr_link: null,
            },
            {
              name: 'feat/a',
              parent: 'main',
              pr_number: null,
              pr_link: null,
            },
          ],
        },
      ],
    });

    const result = await children('/tmp/repo');
    expect(result.children).toEqual(['feat/a', 'feat/b']);
  });

  it('throws with remediation for untracked branch', async () => {
    vi.mocked(getCurrentBranch).mockResolvedValue('feat/a');
    vi.mocked(readState).mockResolvedValue({ stacks: [] });

    await expect(children('/tmp/repo')).rejects.toMatchObject({
      message: expect.stringContaining("'feat/a' is not tracked"),
      recovery: expect.arrayContaining([expect.stringContaining('dub track')]),
    });
  });
});
