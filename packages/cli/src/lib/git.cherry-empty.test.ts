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
import { hasUniquePatchCommits } from './git';

const mockExeca = execa as unknown as MockInstance;

interface MockCall {
  args: string[];
}

function calls(): MockCall[] {
  return mockExeca.mock.calls.map((call) => ({
    args: call[1] as string[],
  }));
}

function ancestorError(): Error & { exitCode: number } {
  const err = new Error('not ancestor') as Error & { exitCode: number };
  err.exitCode = 1;
  return err;
}

/**
 * Regression coverage for the Graphite v1.7.18 range-diff bug class
 * (DUB-19): never treat an empty comparison-command output as
 * "equivalent" on its own. `git cherry` returning empty stdout while the
 * head and base SHAs differ would, without the guard, cause sync /
 * restack to silently skip the branch and discard local work.
 */
describe('hasUniquePatchCommits — empty cherry output', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports unique commits when cherry is empty but SHAs differ (guard)', async () => {
    mockExeca.mockImplementation((_cmd: string, args: string[]) => {
      const [sub, second, third] = args;
      if (sub === 'cherry') return Promise.resolve({ stdout: '' });
      if (sub === 'rev-parse') {
        return Promise.resolve({
          stdout: second === 'feat' ? 'aaaaaaa' : 'bbbbbbb',
        });
      }
      if (sub === 'merge-base' && second === '--is-ancestor') {
        // feat is NOT an ancestor of main — i.e. head has its own work.
        return Promise.reject(ancestorError());
      }
      throw new Error(`unexpected git ${sub} ${second ?? ''} ${third ?? ''}`);
    });

    await expect(hasUniquePatchCommits('main', 'feat', '/repo')).resolves.toBe(
      true,
    );

    const cmds = calls().map((c) => c.args.join(' '));
    expect(cmds).toContain('cherry main feat');
    expect(cmds).toContain('rev-parse main');
    expect(cmds).toContain('rev-parse feat');
    expect(cmds).toContain('merge-base --is-ancestor feat main');
  });

  it('reports no unique commits when cherry is empty and SHAs match', async () => {
    mockExeca.mockImplementation((_cmd: string, args: string[]) => {
      const [sub] = args;
      if (sub === 'cherry') return Promise.resolve({ stdout: '' });
      if (sub === 'rev-parse')
        return Promise.resolve({ stdout: 'samesamesame' });
      throw new Error(`unexpected git ${sub}`);
    });

    await expect(hasUniquePatchCommits('main', 'feat', '/repo')).resolves.toBe(
      false,
    );
  });

  it('reports no unique commits when cherry is empty and head is an ancestor of base', async () => {
    mockExeca.mockImplementation((_cmd: string, args: string[]) => {
      const [sub, second] = args;
      if (sub === 'cherry') return Promise.resolve({ stdout: '' });
      if (sub === 'rev-parse') {
        return Promise.resolve({
          stdout: second === 'feat' ? 'aaaaaaa' : 'bbbbbbb',
        });
      }
      if (sub === 'merge-base' && second === '--is-ancestor') {
        // feat IS an ancestor of main — legitimate equivalence.
        return Promise.resolve({ stdout: '' });
      }
      throw new Error(`unexpected git ${sub}`);
    });

    await expect(hasUniquePatchCommits('main', 'feat', '/repo')).resolves.toBe(
      false,
    );
  });
});
