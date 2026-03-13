import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DubError } from '../lib/errors';
import * as git from '../lib/git';
import * as state from '../lib/state';
import { modify } from './modify';
import * as restackModule from './restack';

vi.mock('../lib/git');
vi.mock('../lib/state');
vi.mock('./restack');

describe('modify', () => {
  const cwd = '/tmp/test';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(restackModule.restack).mockResolvedValue({
      status: 'up-to-date',
      rebased: [],
    });
  });

  it('should amend commit by default', async () => {
    vi.mocked(git.getCurrentBranch).mockResolvedValue('feature-branch');
    vi.mocked(state.readState).mockResolvedValue({ stacks: [] });
    vi.mocked(git.hasStagedChanges).mockResolvedValue(true);
    vi.mocked(git.isWorkingTreeClean).mockResolvedValue(true);

    await modify(cwd, {});

    expect(git.amendCommit).toHaveBeenCalledWith(cwd, {
      message: undefined,
      noEdit: false,
    });
    expect(restackModule.restack).toHaveBeenCalled();
  });

  it('should create new commit with -c flag', async () => {
    vi.mocked(git.getCurrentBranch).mockResolvedValue('feature-branch');
    vi.mocked(state.readState).mockResolvedValue({ stacks: [] });
    vi.mocked(git.hasStagedChanges).mockResolvedValue(true);

    await modify(cwd, { commit: true, message: 'new commit' });

    expect(git.commit).toHaveBeenCalledWith(cwd, {
      message: 'new commit',
      noEdit: true,
    });
    expect(restackModule.restack).toHaveBeenCalled();
  });

  it('should stage all changes with -a flag', async () => {
    vi.mocked(git.getCurrentBranch).mockResolvedValue('feature-branch');
    vi.mocked(state.readState).mockResolvedValue({ stacks: [] });
    vi.mocked(git.hasStagedChanges).mockResolvedValue(true);

    await modify(cwd, { all: true });

    expect(git.stageAll).toHaveBeenCalledWith(cwd);
    expect(git.amendCommit).toHaveBeenCalled();
  });

  it('should run interactive rebase when requested', async () => {
    vi.mocked(git.getCurrentBranch).mockResolvedValue('feature-branch');
    vi.mocked(state.getParent).mockReturnValue('main');

    vi.mocked(state.readState).mockResolvedValue({
      stacks: [
        {
          id: '1',
          branches: [
            {
              name: 'main',
              type: 'root',
              parent: null,
              pr_number: null,
              pr_link: null,
            },
            {
              name: 'feature-branch',
              parent: 'main',
              pr_number: null,
              pr_link: null,
            },
          ],
        },
      ],
    });
    vi.mocked(git.getBranchTip).mockResolvedValue('sha-main');

    await modify(cwd, { interactiveRebase: true });

    expect(git.interactiveRebase).toHaveBeenCalledWith('sha-main', cwd);
    expect(restackModule.restack).toHaveBeenCalled();
  });

  it('prints staged diff with --verbose', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.mocked(git.getCurrentBranch).mockResolvedValue('feature-branch');
    vi.mocked(state.readState).mockResolvedValue({ stacks: [] });
    vi.mocked(git.hasStagedChanges).mockResolvedValue(true);
    vi.mocked(git.getDiff).mockResolvedValue('staged diff');

    await modify(cwd, { verbose: 1 });

    expect(git.getDiff).toHaveBeenCalledWith(cwd, true);
    expect(logSpy).toHaveBeenCalledWith('staged diff');
    logSpy.mockRestore();
  });

  it('prints unstaged diff too with --verbose --verbose', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.mocked(git.getCurrentBranch).mockResolvedValue('feature-branch');
    vi.mocked(state.readState).mockResolvedValue({ stacks: [] });
    vi.mocked(git.hasStagedChanges).mockResolvedValue(true);
    vi.mocked(git.getDiff)
      .mockResolvedValueOnce('staged diff')
      .mockResolvedValueOnce('unstaged diff');

    await modify(cwd, { verbose: 2 });

    expect(git.getDiff).toHaveBeenNthCalledWith(1, cwd, true);
    expect(git.getDiff).toHaveBeenNthCalledWith(2, cwd, false);
    expect(logSpy).toHaveBeenCalledWith('staged diff');
    expect(logSpy).toHaveBeenCalledWith('unstaged diff');
    logSpy.mockRestore();
  });

  it('joins multiple -m values into one commit message', async () => {
    vi.mocked(git.getCurrentBranch).mockResolvedValue('feature-branch');
    vi.mocked(state.readState).mockResolvedValue({ stacks: [] });
    vi.mocked(git.hasStagedChanges).mockResolvedValue(true);

    await modify(cwd, {
      commit: true,
      message: ['line one', 'line two'],
    });

    expect(git.commit).toHaveBeenCalledWith(cwd, {
      message: 'line one\n\nline two',
      noEdit: true,
    });
  });

  it('modifies a target branch with --into and restores the original branch', async () => {
    vi.mocked(git.getCurrentBranch).mockResolvedValue('feat/c');
    vi.mocked(state.readState).mockResolvedValue({
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
              name: 'feat/a',
              parent: 'main',
              pr_number: null,
              pr_link: null,
            },
            {
              name: 'feat/b',
              parent: 'feat/a',
              pr_number: null,
              pr_link: null,
            },
            {
              name: 'feat/c',
              parent: 'feat/b',
              pr_number: null,
              pr_link: null,
            },
          ],
        },
      ],
    });
    vi.mocked(git.branchExists).mockResolvedValue(true);
    vi.mocked(git.hasStagedChanges).mockResolvedValue(true);
    vi.mocked(restackModule.restack).mockResolvedValue({
      status: 'success',
      rebased: ['feat/c'],
    });

    await modify(cwd, { into: 'feat/b' });

    expect(git.checkoutBranch).toHaveBeenNthCalledWith(1, 'feat/b', cwd);
    expect(git.amendCommit).toHaveBeenCalledWith(cwd, {
      message: undefined,
      noEdit: false,
    });
    expect(restackModule.restack).toHaveBeenCalledWith(cwd);
    expect(git.checkoutBranch).toHaveBeenNthCalledWith(2, 'feat/c', cwd);
  });

  it('treats --into current branch as normal modify flow', async () => {
    vi.mocked(git.getCurrentBranch).mockResolvedValue('feat/current');
    vi.mocked(state.readState).mockResolvedValue({
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
              name: 'feat/current',
              parent: 'main',
              pr_number: null,
              pr_link: null,
            },
          ],
        },
      ],
    });
    vi.mocked(git.branchExists).mockResolvedValue(true);
    vi.mocked(git.hasStagedChanges).mockResolvedValue(true);

    await modify(cwd, { into: 'feat/current' });

    expect(git.checkoutBranch).not.toHaveBeenCalled();
    expect(git.amendCommit).toHaveBeenCalled();
  });

  it('throws when --into target does not exist', async () => {
    vi.mocked(git.getCurrentBranch).mockResolvedValue('feat/current');
    vi.mocked(state.readState).mockResolvedValue({
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
              name: 'feat/current',
              parent: 'main',
              pr_number: null,
              pr_link: null,
            },
          ],
        },
      ],
    });
    vi.mocked(git.branchExists).mockResolvedValue(false);

    await expect(modify(cwd, { into: 'feat/missing' })).rejects.toThrow(
      "Target branch 'feat/missing' not found.",
    );
  });

  it('throws when --into target is outside the current stack', async () => {
    vi.mocked(git.getCurrentBranch).mockResolvedValue('feat/current');
    vi.mocked(state.readState).mockResolvedValue({
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
              name: 'feat/current',
              parent: 'main',
              pr_number: null,
              pr_link: null,
            },
          ],
        },
        {
          id: 'stack-2',
          branches: [
            {
              name: 'other-main',
              type: 'root',
              parent: null,
              pr_number: null,
              pr_link: null,
            },
            {
              name: 'feat/elsewhere',
              parent: 'other-main',
              pr_number: null,
              pr_link: null,
            },
          ],
        },
      ],
    });
    vi.mocked(git.branchExists).mockResolvedValue(true);

    await expect(modify(cwd, { into: 'feat/elsewhere' })).rejects.toThrow(
      "Target branch 'feat/elsewhere' is not in the current stack.",
    );
  });

  it('throws when --into target is a root branch', async () => {
    vi.mocked(git.getCurrentBranch).mockResolvedValue('feat/current');
    vi.mocked(state.readState).mockResolvedValue({
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
              name: 'feat/current',
              parent: 'main',
              pr_number: null,
              pr_link: null,
            },
          ],
        },
      ],
    });
    vi.mocked(git.branchExists).mockResolvedValue(true);

    await expect(modify(cwd, { into: 'main' })).rejects.toThrow(
      "Cannot use --into with root branch 'main'.",
    );
  });

  it('throws when --into is combined with --interactive-rebase', async () => {
    vi.mocked(git.getCurrentBranch).mockResolvedValue('feat/current');
    vi.mocked(state.readState).mockResolvedValue({ stacks: [] });

    await expect(
      modify(cwd, { into: 'feat/older', interactiveRebase: true }),
    ).rejects.toThrow('Cannot combine --into with --interactive-rebase.');
  });

  it('prints conflict guidance when restack returns conflict', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.mocked(git.getCurrentBranch).mockResolvedValue('feature-branch');
    vi.mocked(state.readState).mockResolvedValue({ stacks: [] });
    vi.mocked(git.hasStagedChanges).mockResolvedValue(true);
    vi.mocked(restackModule.restack).mockResolvedValue({
      status: 'conflict',
      rebased: [],
      conflictBranch: 'feature-branch',
    });

    await modify(cwd, {});

    expect(logSpy).toHaveBeenCalledWith(
      '⚠ Modify successful, but auto-restacking encountered conflicts.',
    );
    expect(logSpy).toHaveBeenCalledWith(
      "  Run 'dub restack --continue' to resolve.",
    );
    logSpy.mockRestore();
  });

  it('prints warning when restack fails after modify', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.mocked(git.getCurrentBranch).mockResolvedValue('feature-branch');
    vi.mocked(state.readState).mockResolvedValue({ stacks: [] });
    vi.mocked(git.hasStagedChanges).mockResolvedValue(true);
    vi.mocked(restackModule.restack).mockRejectedValue(
      new DubError('Working tree has uncommitted changes.'),
    );

    await modify(cwd, {});

    expect(logSpy).toHaveBeenCalledWith(
      '⚠ Modify successful, but auto-restacking failed.',
    );
    expect(logSpy).toHaveBeenCalledWith(
      '  Working tree has uncommitted changes.',
    );
    logSpy.mockRestore();
  });
});
