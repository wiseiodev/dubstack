import { execa } from 'execa';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resumeCleanup } from '../lib/cleanup-resume';
import { DubError } from '../lib/errors';
import { rebaseContinue } from '../lib/git';
import { detectActiveOperation } from '../lib/operation-state';
import { aiResolve } from './ai-resolve';
import { continueCommand } from './continue';
import { restackContinue } from './restack';

vi.mock('../lib/operation-state');
vi.mock('../lib/git');
vi.mock('../lib/cleanup-resume');
vi.mock('./restack');
vi.mock('./ai-resolve');
vi.mock('execa');

describe('continue command', () => {
  const cwd = '/tmp/repo';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(restackContinue).mockResolvedValue({
      status: 'success',
      rebased: ['feat/a'],
      dryRun: false,
    });
    vi.mocked(rebaseContinue).mockResolvedValue(undefined);
    vi.mocked(aiResolve).mockResolvedValue(undefined);
    vi.mocked(resumeCleanup).mockResolvedValue({
      applied: [],
      alreadyApplied: [],
    });
  });

  it('throws when no operation is active', async () => {
    vi.mocked(detectActiveOperation).mockResolvedValue('none');

    await expect(continueCommand(cwd)).rejects.toThrow(DubError);
    await expect(continueCommand(cwd)).rejects.toThrow('No operation');
  });

  it('continues an active rebase', async () => {
    vi.mocked(detectActiveOperation).mockResolvedValue('rebase');

    const result = await continueCommand(cwd);

    expect(rebaseContinue).toHaveBeenCalledWith(cwd);
    expect(result.continued).toBe('rebase');
  });

  it('continues a restack operation', async () => {
    vi.mocked(detectActiveOperation).mockResolvedValue('restack');

    const result = await continueCommand(cwd);

    expect(restackContinue).toHaveBeenCalledWith(cwd);
    expect(result.continued).toBe('restack');
  });

  it('continues a cleanup operation by replaying the journal', async () => {
    vi.mocked(detectActiveOperation).mockResolvedValue('cleanup');
    vi.mocked(resumeCleanup).mockResolvedValue({
      applied: [{ type: 'delete', branch: 'middle', reason: 'merged-pr' }],
      alreadyApplied: [],
    });

    const result = await continueCommand(cwd);

    expect(resumeCleanup).toHaveBeenCalledWith(cwd);
    expect(result.continued).toBe('cleanup');
    expect(result.cleanupResult?.applied).toHaveLength(1);
  });

  it('--ai triggers aiResolve when conflicts exist', async () => {
    vi.mocked(execa).mockResolvedValue({
      stdout: 'src/foo.ts\nsrc/bar.ts',
    } as never);

    const result = await continueCommand(cwd, { ai: true });

    expect(execa).toHaveBeenCalledWith(
      'git',
      ['diff', '--name-only', '--diff-filter=U'],
      { cwd },
    );
    expect(aiResolve).toHaveBeenCalledWith(cwd, {});
    expect(result.continued).toBe('ai-resolve');
  });

  it('--ai falls through to normal continue when no conflicts', async () => {
    vi.mocked(execa).mockResolvedValue({ stdout: '' } as never);
    vi.mocked(detectActiveOperation).mockResolvedValue('rebase');

    const result = await continueCommand(cwd, { ai: true });

    expect(execa).toHaveBeenCalledWith(
      'git',
      ['diff', '--name-only', '--diff-filter=U'],
      { cwd },
    );
    expect(aiResolve).not.toHaveBeenCalled();
    expect(rebaseContinue).toHaveBeenCalledWith(cwd);
    expect(result.continued).toBe('rebase');
  });
});
