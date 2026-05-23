import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import { createTestRepo, gitInRepo } from '../../test/helpers';
import {
  collectSupportBundle,
  formatSupportBundleSummaryMarkdown,
  type SupportBundle,
  type SupportBundleCollectorOverrides,
} from './support-bundle';

function makeBundle(overrides: Partial<SupportBundle> = {}): SupportBundle {
  return {
    schemaVersion: '1',
    generatedAt: '2026-03-11T00:00:00.000Z',
    cwd: '/repo',
    collection: {
      partial: false,
      errors: [],
    },
    sources: {
      repo: {
        gitRoot: '/repo',
        currentBranch: 'feat/a',
        remotes: ['origin\tgit@github.com:acme/repo.git (fetch)'],
      },
      stack: {
        tracked: true,
        trunk: 'main',
        currentBranch: 'feat/a',
        parentBranch: 'main',
        children: ['feat/b'],
        pathToCurrent: ['main', 'feat/a'],
        branchCount: 2,
      },
      doctor: {
        healthy: true,
        checkedBranch: 'feat/a',
        issues: [],
      },
      git: {
        statusShort: ['## feat/a...origin/feat/a'],
        recentCommits: ['abcd123 feat: add support bundle'],
      },
      history: {
        recentEntries: [
          {
            timestamp: '2026-03-11T00:00:00.000Z',
            command: 'dub doctor',
            status: 'success',
            durationMs: 120,
          },
        ],
      },
      tooling: {
        nodeVersion: 'v22.14.0',
        platform: 'darwin',
        arch: 'arm64',
        gitVersion: 'git version 2.49.0',
        ghVersion: 'gh version 2.74.0',
      },
      sync: {
        lastSyncAt: null,
        reconcileSources: {},
      },
    },
    ...overrides,
  };
}

describe('support-bundle', () => {
  it('collects bundle data using source-specific collectors', async () => {
    const collectors: SupportBundleCollectorOverrides = {
      now: () => '2026-03-11T00:00:00.000Z',
      collectRepo: async () => ({
        gitRoot: '/repo',
        currentBranch: 'feat/a',
        remotes: [],
      }),
      collectStack: async () => ({
        tracked: false,
        trunk: null,
        currentBranch: 'feat/a',
        parentBranch: null,
        children: [],
        pathToCurrent: [],
        branchCount: 0,
      }),
      collectDoctor: async () => ({
        healthy: true,
        checkedBranch: 'feat/a',
        issues: [],
      }),
      collectGit: async () => ({
        statusShort: [],
        recentCommits: [],
      }),
      collectHistory: async () => ({
        recentEntries: [],
      }),
      collectTooling: async () => ({
        nodeVersion: 'v22.14.0',
        platform: 'darwin',
        arch: 'arm64',
        gitVersion: 'git version 2.49.0',
        ghVersion: null,
      }),
    };

    const bundle = await collectSupportBundle('/repo', { collectors });

    expect(bundle.schemaVersion).toBe('1');
    expect(bundle.generatedAt).toBe('2026-03-11T00:00:00.000Z');
    expect(bundle.cwd).toBe('/repo');
    expect(bundle.collection.partial).toBe(false);
    expect(bundle.collection.errors).toEqual([]);
    expect(bundle.sources.stack?.tracked).toBe(false);
    expect(bundle.sources.tooling?.ghVersion).toBeNull();
  });

  it('keeps collecting remaining sections when one source fails', async () => {
    const bundle = await collectSupportBundle('/repo', {
      collectors: {
        collectRepo: async () => {
          throw new Error('no git repo');
        },
        collectStack: async () => ({
          tracked: false,
          trunk: null,
          currentBranch: null,
          parentBranch: null,
          children: [],
          pathToCurrent: [],
          branchCount: 0,
        }),
        collectDoctor: async () => ({
          healthy: false,
          checkedBranch: 'feat/a',
          issues: [{ code: 'x', summary: 'y', fixes: ['dub doctor'] }],
        }),
        collectGit: async () => ({ statusShort: [], recentCommits: [] }),
        collectHistory: async () => ({ recentEntries: [] }),
        collectTooling: async () => ({
          nodeVersion: 'v22.14.0',
          platform: 'darwin',
          arch: 'arm64',
          gitVersion: null,
          ghVersion: null,
        }),
      },
    });

    expect(bundle.collection.partial).toBe(true);
    expect(bundle.collection.errors).toEqual([
      { source: 'repo', message: 'no git repo' },
    ]);
    expect(bundle.sources.repo).toBeNull();
    expect(bundle.sources.doctor?.issues).toHaveLength(1);
  });

  it('formats markdown summary for operators', () => {
    const markdown = formatSupportBundleSummaryMarkdown(
      makeBundle({
        collection: {
          partial: true,
          errors: [{ source: 'repo', message: 'no git repo' }],
        },
      }),
    );

    expect(markdown).toContain('# DubStack Support Report');
    expect(markdown).toContain('Collection status: partial');
    expect(markdown).toContain('- repo: unavailable');
    expect(markdown).toContain('- doctor: healthy');
    expect(markdown).toContain('Recent Dub commands');
  });

  it('includes reconcile-source histogram in markdown when last sync exists', () => {
    const markdown = formatSupportBundleSummaryMarkdown(
      makeBundle({
        sources: {
          ...makeBundle().sources,
          sync: {
            lastSyncAt: '2026-05-23T12:00:00.000Z',
            reconcileSources: {
              'sync-no-change': 3,
              'sync-rebase-onto-remote': 1,
            },
          },
        },
      }),
    );

    expect(markdown).toContain('Last Sync Reconcile Sources');
    expect(markdown).toContain('- sync-no-change: 3');
    expect(markdown).toContain('- sync-rebase-onto-remote: 1');
    expect(markdown).toContain('last 2026-05-23T12:00:00.000Z');
  });
});

describe('support-bundle default collectors', () => {
  it('redacts credentials from git remotes in repo context', async () => {
    const repo = await createTestRepo();

    try {
      await gitInRepo(repo.dir, [
        'remote',
        'add',
        'origin',
        'https://x-access-token:ghp_supersecret@github.com/acme/repo.git',
      ]);

      const bundle = await collectSupportBundle(repo.dir);
      const remotes = bundle.sources.repo?.remotes ?? [];

      expect(remotes.length).toBeGreaterThan(0);
      expect(remotes.join('\n')).toContain('[REDACTED]@');
      expect(remotes.join('\n')).not.toContain('ghp_supersecret');
    } finally {
      await repo.cleanup();
    }
  });

  it('marks stack source as failed when stack state contains a cycle', async () => {
    const repo = await createTestRepo();

    try {
      await gitInRepo(repo.dir, ['checkout', '-b', 'feat/a']);
      await gitInRepo(repo.dir, ['checkout', '-b', 'feat/b']);
      await gitInRepo(repo.dir, ['checkout', 'feat/a']);

      const stateDir = path.join(repo.dir, '.git', 'dubstack');
      await fs.promises.mkdir(stateDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(stateDir, 'state.json'),
        JSON.stringify(
          {
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
                    parent: 'feat/b',
                    pr_number: null,
                    pr_link: null,
                  },
                  {
                    name: 'feat/b',
                    parent: 'feat/a',
                    pr_number: null,
                    pr_link: null,
                  },
                ],
              },
            ],
          },
          null,
          2,
        ),
      );

      const bundle = await collectSupportBundle(repo.dir);
      const stackError = bundle.collection.errors.find(
        (error) => error.source === 'stack',
      );

      expect(bundle.sources.stack).toBeNull();
      expect(stackError?.message.toLowerCase()).toContain('cycle');
    } finally {
      await repo.cleanup();
    }
  });

  it('still collects git status when recent commit log cannot be read', async () => {
    const dir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'dubstack-support-test-'),
    );

    try {
      await execa('git', ['init', '-b', 'main'], { cwd: dir });

      const bundle = await collectSupportBundle(dir);

      expect(bundle.sources.git).not.toBeNull();
      expect(bundle.sources.git?.recentCommits).toEqual([]);
      expect(bundle.sources.git?.statusShort.length ?? 0).toBeGreaterThan(0);
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });
});
