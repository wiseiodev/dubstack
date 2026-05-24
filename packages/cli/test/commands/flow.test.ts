import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flow } from '../../src/commands/flow';
import { writeConfig } from '../../src/lib/config';
import { getCurrentBranch } from '../../src/lib/git';
import { createTestRepo, gitInRepo } from '../helpers';

let dir: string;
let cleanup: () => Promise<void>;

function createRenderer() {
  return {
    renderMarkdown: vi.fn(),
    renderPreview: vi.fn(),
    renderStatus: vi.fn(),
    renderToolActivity: vi.fn(),
  };
}

beforeEach(async () => {
  const repo = await createTestRepo();
  dir = repo.dir;
  cleanup = repo.cleanup;
});

afterEach(async () => {
  await cleanup();
});

describe('flow integration', () => {
  it('creates the branch, commits staged content from file, and submits with the generated summary override', async () => {
    await writeConfig(
      {
        aiAssistantEnabled: true,
        ai: {
          defaults: {
            createMetadata: false,
            submitDescription: false,
            flow: true,
          },
        },
      },
      dir,
    );

    fs.writeFileSync(
      path.join(dir, 'flow-feature.ts'),
      'export const flowFeature = true;\n',
    );

    const submit = vi.fn().mockResolvedValue({
      pushed: ['feat/flow-real'],
      created: ['feat/flow-real'],
      updated: [],
      path: 'current',
      dryRun: false,
    });

    const result = await flow(
      dir,
      {
        all: true,
        yes: true,
      },
      {
        generateFlowMetadata: vi.fn().mockResolvedValue({
          branch: 'feat/flow-real',
          commitMessage: 'feat: add real flow coverage',
          prDescription: '## Summary\n\nAdds real flow coverage.',
        }),
        readMetadataTemplates: vi.fn().mockResolvedValue({
          prTemplate: null,
          commitTemplate: null,
        }),
        createTerminalRenderer: vi.fn().mockReturnValue(createRenderer()),
        submit,
      },
    );

    expect(result.aborted).toBe(false);
    expect(await getCurrentBranch(dir)).toBe('feat/flow-real');

    const { stdout: subject } = await gitInRepo(dir, [
      'log',
      '-1',
      '--format=%s',
    ]);
    expect(subject.trim()).toBe('feat: add real flow coverage');

    const { stdout: trackedFile } = await gitInRepo(dir, [
      'show',
      'HEAD:flow-feature.ts',
    ]);
    expect(trackedFile).toContain('flowFeature = true');

    expect(submit).toHaveBeenCalledWith(dir, false, {
      path: 'current',
      fix: false,
      summaryOverrides: new Map([
        ['feat/flow-real', '## Summary\n\nAdds real flow coverage.'],
      ]),
    });
  });
});
