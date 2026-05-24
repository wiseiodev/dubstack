import { describe, expect, it, vi } from 'vitest';
import { flow } from './flow';

function createRenderer() {
  return {
    renderMarkdown: vi.fn(),
    renderPreview: vi.fn(),
    renderStatus: vi.fn(),
    renderToolActivity: vi.fn(),
  };
}

describe('flow', () => {
  it('stages all changes, previews generated content, and delegates create plus submit when auto-approved', async () => {
    const renderer = createRenderer();
    const create = vi.fn().mockResolvedValue({
      branch: 'feat/flow-preview',
      parent: 'main',
    });
    const submit = vi.fn().mockResolvedValue({
      pushed: ['feat/flow-preview'],
      created: ['feat/flow-preview'],
      updated: [],
      path: 'current',
      dryRun: false,
    });
    const commitStagedFromFile = vi.fn().mockResolvedValue(undefined);
    const getDiffFileNames = vi
      .fn()
      .mockResolvedValue(['packages/cli/src/commands/flow.ts']);
    const getDiffNumStat = vi.fn().mockResolvedValue([
      {
        path: 'packages/cli/src/commands/flow.ts',
        additions: 10,
        deletions: 2,
      },
    ]);

    const result = await flow(
      '/repo',
      {
        all: true,
        yes: true,
      },
      {
        readConfig: vi.fn().mockResolvedValue({
          aiAssistantEnabled: true,
          ai: {
            defaults: {
              flow: true,
              createMetadata: true,
            },
          },
        }),
        getCurrentBranch: vi.fn().mockResolvedValue('main'),
        hasStagedChanges: vi.fn().mockResolvedValue(true),
        stageAll: vi.fn().mockResolvedValue(undefined),
        stageUpdate: vi.fn(),
        interactiveStage: vi.fn(),
        getDiff: vi.fn().mockResolvedValue('diff --git a/file b/file'),
        getDiffFileNames,
        getDiffNumStat,
        generateFlowMetadata: vi.fn().mockResolvedValue({
          branch: 'feat/flow-preview',
          commitMessage: 'feat: generated from flow',
          prDescription: '## Summary\n\nGenerated PR description',
        }),
        create,
        submit,
        commitStagedFromFile,
        createTerminalRenderer: vi.fn().mockReturnValue(renderer),
        promptApproval: vi.fn(),
        editGeneratedContent: vi.fn(),
      },
    );

    expect(result.branch).toBe('feat/flow-preview');
    expect(result.dryRun).toBe(false);
    expect(renderer.renderPreview).toHaveBeenCalled();
    expect(getDiffFileNames).toHaveBeenCalledWith('/repo', true);
    expect(getDiffNumStat).toHaveBeenCalledWith('/repo', true);
    expect(create).toHaveBeenCalledWith('feat/flow-preview', '/repo', {
      noAi: true,
    });
    expect(commitStagedFromFile).toHaveBeenCalledWith(
      expect.any(String),
      '/repo',
    );
    expect(submit).toHaveBeenCalledWith('/repo', false, {
      path: 'current',
      fix: false,
      summaryOverrides: new Map([
        ['feat/flow-preview', '## Summary\n\nGenerated PR description'],
      ]),
    });
  });

  it('supports interactive edit before applying generated content', async () => {
    const renderer = createRenderer();
    const commitStagedFromFile = vi
      .fn()
      .mockImplementation(async (filePath: string) => {
        const { readFile } = await import('node:fs/promises');
        const body = await readFile(filePath, 'utf8');
        expect(body).toContain('feat: edited commit');
      });

    await flow(
      '/repo',
      {},
      {
        readConfig: vi.fn().mockResolvedValue({
          aiAssistantEnabled: true,
          ai: {
            defaults: {
              flow: true,
            },
          },
        }),
        getCurrentBranch: vi.fn().mockResolvedValue('main'),
        hasStagedChanges: vi.fn().mockResolvedValue(true),
        stageAll: vi.fn(),
        stageUpdate: vi.fn(),
        interactiveStage: vi.fn(),
        getDiff: vi.fn().mockResolvedValue('diff --git a/file b/file'),
        getDiffFileNames: vi
          .fn()
          .mockResolvedValue(['packages/cli/src/commands/flow.ts']),
        getDiffNumStat: vi.fn().mockResolvedValue([
          {
            path: 'packages/cli/src/commands/flow.ts',
            additions: 10,
            deletions: 2,
          },
        ]),
        generateFlowMetadata: vi.fn().mockResolvedValue({
          branch: 'feat/flow-preview',
          commitMessage: 'feat: generated from flow',
          prDescription: 'Generated PR description',
        }),
        create: vi.fn().mockResolvedValue({
          branch: 'feat/flow-preview',
          parent: 'main',
        }),
        submit: vi.fn().mockResolvedValue({
          pushed: ['feat/flow-preview'],
          created: ['feat/flow-preview'],
          updated: [],
          path: 'current',
          dryRun: false,
        }),
        commitStagedFromFile,
        createTerminalRenderer: vi.fn().mockReturnValue(renderer),
        promptApproval: vi.fn().mockResolvedValue('edit'),
        editGeneratedContent: vi.fn().mockResolvedValue({
          commitMessage: 'feat: edited commit',
          prDescription: '## Edited\n\nUpdated PR body',
        }),
      },
    );

    expect(commitStagedFromFile).toHaveBeenCalled();
  });

  it('aborts without mutating when approval is declined', async () => {
    const create = vi.fn();
    const submit = vi.fn();

    const result = await flow(
      '/repo',
      {},
      {
        readConfig: vi.fn().mockResolvedValue({
          aiAssistantEnabled: true,
          ai: {
            defaults: {
              flow: true,
            },
          },
        }),
        getCurrentBranch: vi.fn().mockResolvedValue('main'),
        hasStagedChanges: vi.fn().mockResolvedValue(true),
        stageAll: vi.fn(),
        stageUpdate: vi.fn(),
        interactiveStage: vi.fn(),
        getDiff: vi.fn().mockResolvedValue('diff --git a/file b/file'),
        getDiffFileNames: vi
          .fn()
          .mockResolvedValue(['packages/cli/src/commands/flow.ts']),
        getDiffNumStat: vi.fn().mockResolvedValue([
          {
            path: 'packages/cli/src/commands/flow.ts',
            additions: 10,
            deletions: 2,
          },
        ]),
        generateFlowMetadata: vi.fn().mockResolvedValue({
          branch: 'feat/flow-preview',
          commitMessage: 'feat: generated from flow',
          prDescription: 'Generated PR description',
        }),
        create,
        submit,
        commitStagedFromFile: vi.fn(),
        createTerminalRenderer: vi.fn().mockReturnValue(createRenderer()),
        promptApproval: vi.fn().mockResolvedValue('cancel'),
        editGeneratedContent: vi.fn(),
      },
    );

    expect(result.aborted).toBe(true);
    expect(create).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });
});
