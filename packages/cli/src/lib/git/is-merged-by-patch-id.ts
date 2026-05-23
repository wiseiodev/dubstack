import { execa } from '../exec';

export interface IsMergedByPatchIdOptions {
  maxCommits?: number;
  warn?: (message: string) => void;
}

const DEFAULT_MAX_COMMITS = 200;

/**
 * Detects whether `branch`'s changes have already landed in `trunk` via
 * squash or rebase merge, when no PR metadata is available.
 *
 * Algorithm (Charcoal-style): walk branch commits base→tip with a rolling
 * `currentBase`. For each commit, build a synthetic commit applying the
 * commit's cumulative tree on top of `currentBase`, then ask `git cherry`
 * whether trunk already contains an equivalent patch. When matched, advance
 * `currentBase` to the original branch commit so later iterations measure
 * cumulative deltas from that point — this lets squash-merges resolve on the
 * branch tip even when intermediate commits don't individually appear in
 * trunk. The branch is considered merged when the walk advances all the way
 * to the branch tip.
 *
 * Guards against the Graphite v1.7.0 hanging bug on huge diffs by capping
 * commit iteration; beyond the cap the helper returns false and warns.
 */
export async function isMergedByPatchId(
  branch: string,
  trunk: string,
  cwd: string,
  options: IsMergedByPatchIdOptions = {},
): Promise<boolean> {
  const maxCommits = options.maxCommits ?? DEFAULT_MAX_COMMITS;
  const warn = options.warn ?? defaultWarn;

  const mergeBase = await tryRun('git', ['merge-base', trunk, branch], cwd);
  if (mergeBase == null) return false;

  const branchTip = await tryRun('git', ['rev-parse', branch], cwd);
  if (branchTip == null) return false;

  const commitsOutput = await tryRun(
    'git',
    ['rev-list', '--reverse', `${mergeBase}..${branch}`],
    cwd,
  );
  if (commitsOutput == null) return false;
  const commits = commitsOutput.split('\n').filter(Boolean);

  if (commits.length > maxCommits) {
    warn(
      `isMergedByPatchId: branch '${branch}' has ${commits.length} commits (> ${maxCommits} cap); treating as not merged.`,
    );
    return false;
  }

  let currentBase = mergeBase;
  for (const commit of commits) {
    const treeSha = await tryRun('git', ['rev-parse', `${commit}^{tree}`], cwd);
    if (treeSha == null) return false;

    const syntheticCommit = await commitTree(treeSha, currentBase, commit, cwd);
    if (syntheticCommit == null) return false;

    const cherryOutput = await tryRun(
      'git',
      ['cherry', trunk, syntheticCommit, currentBase],
      cwd,
    );
    if (cherryOutput == null) return false;

    const firstLine = cherryOutput
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (firstLine?.startsWith('-')) {
      currentBase = commit;
    }
  }

  return currentBase === branchTip;
}

async function tryRun(
  command: string,
  args: string[],
  cwd: string,
): Promise<string | null> {
  try {
    const { stdout } = await execa(command, args, { cwd });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function commitTree(
  treeSha: string,
  parent: string,
  originalSha: string,
  cwd: string,
): Promise<string | null> {
  try {
    const { stdout } = await execa(
      'git',
      ['commit-tree', treeSha, '-p', parent, '-m', `synthetic ${originalSha}`],
      {
        cwd,
        env: {
          GIT_AUTHOR_NAME: 'dubstack',
          GIT_AUTHOR_EMAIL: 'dubstack@local',
          GIT_COMMITTER_NAME: 'dubstack',
          GIT_COMMITTER_EMAIL: 'dubstack@local',
        },
      },
    );
    return stdout.trim();
  } catch {
    return null;
  }
}

function defaultWarn(message: string): void {
  console.warn(`⚠ ${message}`);
}
