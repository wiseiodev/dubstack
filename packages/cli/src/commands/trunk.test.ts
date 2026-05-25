import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getCurrentBranch, isValidBranchName } from '../lib/git';
import { readState, writeState } from '../lib/state';
import {
  addTrunk,
  listTrunks,
  removeTrunk,
  setDefaultTrunk,
  trunk,
} from './trunk';

vi.mock('../lib/git');
vi.mock('../lib/state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/state')>();
  return {
    ...actual,
    readState: vi.fn(),
    writeState: vi.fn(),
  };
});

describe('trunk command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(writeState).mockResolvedValue(undefined);
    vi.mocked(isValidBranchName).mockResolvedValue(true);
  });

  it('returns trunk for tracked branch', async () => {
    vi.mocked(getCurrentBranch).mockResolvedValue('feat/a');
    vi.mocked(readState).mockResolvedValue({
      stacks: [
        {
          id: 'stack-1',
          trunk: 'develop',
          branches: [
            {
              name: 'develop',
              type: 'root',
              parent: null,
              pr_number: null,
              pr_link: null,
            },
            {
              name: 'feat/a',
              parent: 'develop',
              pr_number: null,
              pr_link: null,
            },
          ],
        },
      ],
    });

    const result = await trunk('/tmp/repo');
    expect(result.trunk).toBe('develop');
  });

  it('throws with remediation for untracked branch', async () => {
    vi.mocked(getCurrentBranch).mockResolvedValue('feat/a');
    vi.mocked(readState).mockResolvedValue({ stacks: [] });

    await expect(trunk('/tmp/repo')).rejects.toMatchObject({
      message: expect.stringContaining("'feat/a' is not tracked"),
      recovery: expect.arrayContaining([expect.stringContaining('dub track')]),
    });
  });

  it('throws with remediation when legacy stack metadata has no root', async () => {
    vi.mocked(getCurrentBranch).mockResolvedValue('feat/a');
    vi.mocked(readState).mockResolvedValue({
      stacks: [
        {
          id: 'stack-1',
          branches: [
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

    await expect(trunk('/tmp/repo')).rejects.toMatchObject({
      message: "Stack for 'feat/a' is missing a root branch.",
      recovery: expect.arrayContaining([expect.stringContaining('dub doctor')]),
    });
  });

  it('lists configured trunks and marks the default', async () => {
    vi.mocked(readState).mockResolvedValue({
      trunks: ['main', 'develop'],
      defaultTrunk: 'develop',
      stacks: [],
    });

    await expect(listTrunks('/tmp/repo')).resolves.toEqual({
      trunks: [
        { name: 'main', default: false },
        { name: 'develop', default: true },
      ],
    });
  });

  it('adds a configured trunk idempotently', async () => {
    vi.mocked(readState).mockResolvedValue({
      trunks: ['main'],
      defaultTrunk: 'main',
      stacks: [],
    });

    const result = await addTrunk('/tmp/repo', 'develop');

    expect(result).toEqual({ trunk: 'develop', status: 'added' });
    expect(vi.mocked(writeState).mock.calls[0]?.[0]).toMatchObject({
      trunks: ['main', 'develop'],
      defaultTrunk: 'main',
    });
  });

  it('refuses to remove a trunk that still owns stacks', async () => {
    vi.mocked(readState).mockResolvedValue({
      trunks: ['main', 'develop'],
      defaultTrunk: 'main',
      stacks: [
        {
          id: 'stack-1',
          trunk: 'develop',
          branches: [],
        },
      ],
    });

    await expect(removeTrunk('/tmp/repo', 'develop')).rejects.toMatchObject({
      message: "Cannot remove trunk 'develop'.",
    });
    expect(vi.mocked(writeState)).not.toHaveBeenCalled();
  });

  it('sets the default trunk when it is configured', async () => {
    vi.mocked(readState).mockResolvedValue({
      trunks: ['main', 'develop'],
      defaultTrunk: 'main',
      stacks: [],
    });

    await expect(setDefaultTrunk('/tmp/repo', 'develop')).resolves.toEqual({
      trunk: 'develop',
    });
    expect(vi.mocked(writeState).mock.calls[0]?.[0]).toMatchObject({
      defaultTrunk: 'develop',
    });
  });
});
