import { execa } from 'execa';
import { openUrl } from './browser';
import { DubError } from './errors';

/** Details of a GitHub Pull Request. */
export interface PrInfo {
  number: number;
  url: string;
  title: string;
  body: string;
}

export type BranchPrLifecycleState = 'OPEN' | 'CLOSED' | 'MERGED' | 'NONE';

export interface BranchPrSyncInfo {
  state: BranchPrLifecycleState;
  baseRefName: string | null;
}

export interface PrMergeStatus {
  mergeable: string | null;
  mergeStateStatus: string | null;
}

/**
 * Ensures the `gh` CLI is installed and available in PATH.
 * @throws {DubError} If `gh` is not found.
 */
export async function ensureGhInstalled(): Promise<void> {
  try {
    await execa('gh', ['--version']);
  } catch {
    throw new DubError('gh CLI not found.', [
      'Install the GitHub CLI from https://cli.github.com.',
      "Run 'gh --version' to confirm installation, then retry.",
    ]);
  }
}

/**
 * Ensures the user is authenticated with `gh`.
 * @throws {DubError} If not authenticated.
 */
export async function checkGhAuth(): Promise<void> {
  try {
    await execa('gh', ['auth', 'status']);
  } catch {
    throw new DubError('Not authenticated with GitHub.', [
      "Run 'gh auth login' and sign in with the 'repo' scope.",
      "Run 'gh auth status' to confirm authentication, then retry.",
    ]);
  }
}

/**
 * Fetches the open PR for a given head branch, if one exists.
 * @returns The PR info, or `null` if no open PR exists for that branch.
 */
export async function getPr(
  branch: string,
  cwd: string,
): Promise<PrInfo | null> {
  const { stdout } = await execa(
    'gh',
    [
      'pr',
      'list',
      '--head',
      branch,
      '--state',
      'open',
      '--json',
      'number,url,title,body',
      '--jq',
      '.[0]',
    ],
    { cwd },
  );

  const trimmed = stdout.trim();
  if (!trimmed || trimmed === 'null') return null;

  try {
    return JSON.parse(trimmed) as PrInfo;
  } catch {
    throw new DubError(`Failed to parse PR info for branch '${branch}'.`, [
      `Run 'gh pr list --head ${branch}' to inspect the raw response.`,
      'Retry once GitHub is healthy if the response is partial.',
    ]);
  }
}

/**
 * Fetches PR info by number.
 * @returns The PR info, or null if not found.
 */
export async function getPrByNumber(
  prNumber: number,
  cwd: string,
): Promise<PrInfo | null> {
  let stdout: string;
  try {
    const result = await execa(
      'gh',
      [
        'pr',
        'view',
        String(prNumber),
        '--json',
        'number,url,title,body',
        '--jq',
        '.',
      ],
      { cwd },
    );
    stdout = result.stdout;
  } catch (error) {
    if (isPrNotFoundError(error)) return null;
    const message = error instanceof Error ? error.message : String(error);
    throw new DubError(`Failed to fetch PR #${prNumber}: ${message}`, [
      `Run 'gh pr view ${prNumber}' to confirm the PR exists.`,
      "Run 'gh auth status' to verify authentication, then retry.",
    ]);
  }
  const trimmed = stdout.trim();
  if (!trimmed || trimmed === 'null') return null;
  try {
    return JSON.parse(trimmed) as PrInfo;
  } catch {
    throw new DubError(`Failed to parse PR #${prNumber}.`, [
      `Run 'gh pr view ${prNumber} --json number,url,title,body' to inspect the response.`,
      'Retry once GitHub is healthy.',
    ]);
  }
}

/**
 * Returns coarse lifecycle state of a PR associated with the branch head.
 */
export async function getBranchPrLifecycleState(
  branch: string,
  cwd: string,
): Promise<BranchPrLifecycleState> {
  const info = await getBranchPrSyncInfo(branch, cwd);
  return info.state;
}

/**
 * Returns PR lifecycle and base branch information for sync decisions.
 */
export async function getBranchPrSyncInfo(
  branch: string,
  cwd: string,
): Promise<BranchPrSyncInfo> {
  const { stdout } = await execa(
    'gh',
    [
      'pr',
      'list',
      '--head',
      branch,
      '--state',
      'all',
      '--json',
      'state,mergedAt,baseRefName',
      '--jq',
      '.[0]',
    ],
    { cwd },
  );

  const trimmed = stdout.trim();
  if (!trimmed || trimmed === 'null') {
    return { state: 'NONE', baseRefName: null };
  }

  try {
    const parsed = JSON.parse(trimmed) as {
      state?: string;
      mergedAt?: string | null;
      baseRefName?: string | null;
    };
    if (parsed.mergedAt) {
      return {
        state: 'MERGED',
        baseRefName: parsed.baseRefName ?? null,
      };
    }
    if (parsed.state === 'CLOSED') {
      return {
        state: 'CLOSED',
        baseRefName: parsed.baseRefName ?? null,
      };
    }
    if (parsed.state === 'OPEN') {
      return {
        state: 'OPEN',
        baseRefName: parsed.baseRefName ?? null,
      };
    }
    return { state: 'NONE', baseRefName: parsed.baseRefName ?? null };
  } catch {
    throw new DubError(
      `Failed to parse PR lifecycle state for branch '${branch}'.`,
      [
        `Run 'gh pr list --head ${branch}' to inspect the raw response.`,
        'Retry once GitHub is healthy.',
      ],
    );
  }
}

/**
 * Returns coarse lifecycle state of a PR by number.
 */
export async function getPrStateByNumber(
  prNumber: number,
  cwd: string,
): Promise<BranchPrLifecycleState> {
  let stdout: string;
  try {
    const result = await execa(
      'gh',
      ['pr', 'view', String(prNumber), '--json', 'state,mergedAt', '--jq', '.'],
      { cwd },
    );
    stdout = result.stdout;
  } catch (error) {
    if (isPrNotFoundError(error)) return 'NONE';
    const message = error instanceof Error ? error.message : String(error);
    throw new DubError(
      `Failed to fetch PR state for #${prNumber}: ${message}`,
      [
        `Run 'gh pr view ${prNumber}' to confirm the PR exists.`,
        "Run 'gh auth status' to verify authentication, then retry.",
      ],
    );
  }
  const trimmed = stdout.trim();
  if (!trimmed || trimmed === 'null') return 'NONE';
  try {
    const parsed = JSON.parse(trimmed) as {
      state?: string;
      mergedAt?: string | null;
    };
    if (parsed.mergedAt) return 'MERGED';
    if (parsed.state === 'OPEN') return 'OPEN';
    if (parsed.state === 'CLOSED') return 'CLOSED';
    return 'NONE';
  } catch {
    throw new DubError(`Failed to parse PR state for #${prNumber}.`, [
      `Run 'gh pr view ${prNumber} --json state,mergedAt' to inspect the response.`,
      'Retry once GitHub is healthy.',
    ]);
  }
}

/**
 * Returns GitHub's mergeability status for a PR by number.
 */
export async function getPrMergeStatusByNumber(
  prNumber: number,
  cwd: string,
): Promise<PrMergeStatus> {
  let stdout: string;
  try {
    const result = await execa(
      'gh',
      [
        'pr',
        'view',
        String(prNumber),
        '--json',
        'mergeable,mergeStateStatus',
        '--jq',
        '.',
      ],
      { cwd },
    );
    stdout = result.stdout;
  } catch (error) {
    if (isPrNotFoundError(error)) {
      return {
        mergeable: null,
        mergeStateStatus: null,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new DubError(
      `Failed to fetch mergeability for PR #${prNumber}: ${message}`,
      [
        `Run 'gh pr view ${prNumber}' to confirm the PR exists.`,
        "Run 'gh auth status' to verify authentication, then retry.",
      ],
    );
  }

  const trimmed = stdout.trim();
  if (!trimmed || trimmed === 'null') {
    return {
      mergeable: null,
      mergeStateStatus: null,
    };
  }

  try {
    const parsed = JSON.parse(trimmed) as {
      mergeable?: string | null;
      mergeStateStatus?: string | null;
    };
    return {
      mergeable: parsed.mergeable ?? null,
      mergeStateStatus: parsed.mergeStateStatus ?? null,
    };
  } catch {
    throw new DubError(`Failed to parse mergeability for PR #${prNumber}.`, [
      `Run 'gh pr view ${prNumber} --json mergeable,mergeStateStatus' to inspect.`,
      'Retry once GitHub is healthy.',
    ]);
  }
}

function isPrNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes('could not resolve to a pull request') ||
    normalized.includes('could not resolve to a pullrequest') ||
    normalized.includes('no pull requests found') ||
    normalized.includes('not found')
  );
}

/**
 * Creates a new PR and returns its info.
 *
 * Parses the PR number from the URL printed to stdout by `gh pr create`,
 * avoiding an extra API round-trip.
 *
 * @param branch - Head branch
 * @param base - Base branch the PR merges into
 * @param title - PR title
 * @param bodyFile - Absolute path to a file containing the PR body
 */
export async function createPr(
  branch: string,
  base: string,
  title: string,
  bodyFile: string,
  cwd: string,
): Promise<PrInfo> {
  let stdout: string;
  try {
    const result = await execa(
      'gh',
      [
        'pr',
        'create',
        '--head',
        branch,
        '--base',
        base,
        '--title',
        title,
        '--body-file',
        bodyFile,
      ],
      { cwd },
    );
    stdout = result.stdout;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('403') || message.includes('insufficient')) {
      throw new DubError('GitHub token lacks required permissions.', [
        "Run 'gh auth login' and re-select the 'repo' scope.",
        "Run 'gh auth status' to confirm the active scopes after re-login.",
      ]);
    }
    throw new DubError(`Failed to create PR for '${branch}': ${message}`, [
      `Run 'gh pr create --head ${branch}' manually to inspect the failure.`,
      'Confirm the branch has been pushed to the remote, then retry.',
    ]);
  }

  const url = stdout.trim();
  const numberMatch = url.match(/\/pull\/(\d+)$/);
  if (!numberMatch) {
    throw new DubError(`Unexpected output from 'gh pr create': ${url}`, [
      "Inspect the printed URL; if a PR was created, rerun 'dub submit' to refresh metadata.",
      "Run 'gh --version' to verify the installed CLI version, then retry.",
    ]);
  }

  return {
    number: Number.parseInt(numberMatch[1], 10),
    url,
    title,
    body: '',
  };
}

/**
 * Updates a PR's body using a file.
 * @param prNumber - The PR number to update
 * @param bodyFile - Absolute path to a file containing the new body
 */
export async function updatePrBody(
  prNumber: number,
  bodyFile: string,
  cwd: string,
): Promise<void> {
  try {
    await execa(
      'gh',
      ['pr', 'edit', String(prNumber), '--body-file', bodyFile],
      { cwd },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('403') || message.includes('insufficient')) {
      throw new DubError('GitHub token lacks required permissions.', [
        "Run 'gh auth login' and re-select the 'repo' scope.",
        "Run 'gh auth status' to confirm the active scopes after re-login.",
      ]);
    }
    throw new DubError(`Failed to update PR #${prNumber}: ${message}`, [
      `Run 'gh pr edit ${prNumber}' manually to inspect the failure.`,
      "Run 'gh auth status' to verify authentication, then retry.",
    ]);
  }
}

/**
 * Retargets an existing PR to a new base branch.
 */
export async function retargetPrBase(
  target: number | string,
  baseBranch: string,
  cwd: string,
): Promise<void> {
  try {
    await execa('gh', ['pr', 'edit', String(target), '--base', baseBranch], {
      cwd,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DubError(
      `Failed to retarget PR '${target}' to '${baseBranch}': ${message}`,
      [
        `Run 'gh pr edit ${target} --base ${baseBranch}' manually to inspect the failure.`,
        `Confirm '${baseBranch}' exists on the remote, then retry.`,
      ],
    );
  }
}

/**
 * Merges a PR by number using the requested strategy.
 */
export async function mergePr(
  prNumber: number,
  cwd: string,
  options: {
    method?: 'merge' | 'squash' | 'rebase';
    deleteBranch?: boolean;
  } = {},
): Promise<void> {
  const method = options.method ?? 'merge';
  const methodFlag =
    method === 'squash'
      ? '--squash'
      : method === 'rebase'
        ? '--rebase'
        : '--merge';
  const args = ['pr', 'merge', String(prNumber), methodFlag];
  if (options.deleteBranch ?? true) {
    args.push('--delete-branch');
  }
  try {
    await execa('gh', args, { cwd, stdio: 'inherit' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DubError(`Failed to merge PR #${prNumber}: ${message}`, [
      `Run 'gh pr view ${prNumber} --web' to inspect required checks and reviews.`,
      `Run 'dub merge-check --pr ${prNumber}' to validate DubStack merge order.`,
      'Retry once required checks pass.',
    ]);
  }
}

export async function getRepositoryWebUrl(cwd: string): Promise<string> {
  const remote = await getPreferredRemote(cwd);
  let remoteUrl: string;

  try {
    const result = await execa('git', ['remote', 'get-url', remote], { cwd });
    remoteUrl = result.stdout.trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes('not a git repository')) {
      throw new DubError('Not a git repository.', [
        "Run 'git init' in the desired project directory.",
        "Run 'cd <repo>' to switch into an existing git repository and retry.",
      ]);
    }
    throw new DubError(`Failed to read git remote '${remote}': ${message}`, [
      `Run 'git remote -v' to confirm the '${remote}' remote is configured.`,
      `Run 'git remote add ${remote} <url>' to add a remote if it is missing.`,
    ]);
  }

  return normalizeGitHubRepositoryUrl(remoteUrl);
}

export async function openRepositoryInBrowser(cwd: string): Promise<void> {
  const url = await getRepositoryWebUrl(cwd);
  await openUrl(url);
}

/**
 * Opens a PR in the browser via GitHub CLI.
 *
 * @param cwd - Working directory
 * @param target - Optional branch name, PR number, or URL
 */
export async function openPrInBrowser(
  cwd: string,
  target?: string,
): Promise<void> {
  const args = target
    ? ['pr', 'view', target, '--web']
    : ['pr', 'view', '--web'];
  try {
    await execa('gh', args, { cwd, stdio: 'inherit' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes('no pull requests')) {
      throw new DubError(
        target
          ? `No PR found for '${target}'.`
          : 'No PR found for the current branch.',
        target
          ? [
              `Run 'gh pr list --head ${target}' to confirm whether a PR exists.`,
              "Run 'dub submit' to push the branch and create a PR.",
            ]
          : [
              "Run 'dub submit' to push the current branch and create a PR.",
              "Run 'dub ready' to verify the branch is ready to submit.",
            ],
      );
    }
    throw new DubError(
      target
        ? `Failed to open PR for '${target}': ${message}`
        : `Failed to open PR: ${message}`,
      [
        target
          ? `Run 'gh pr view ${target} --web' manually to inspect the failure.`
          : "Run 'gh pr view --web' manually to inspect the failure.",
        "Run 'gh auth status' to verify authentication, then retry.",
      ],
    );
  }
}

async function getPreferredRemote(cwd: string): Promise<string> {
  try {
    const result = await execa(
      'git',
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
      { cwd },
    );
    const upstream = result.stdout.trim();
    const slashIndex = upstream.indexOf('/');
    if (slashIndex > 0) {
      return upstream.slice(0, slashIndex);
    }
  } catch {}

  return 'origin';
}

function normalizeGitHubRepositoryUrl(remoteUrl: string): string {
  const trimmed = remoteUrl.trim();
  const sshMatch = trimmed.match(/^git@github\.com:(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return `https://github.com/${sshMatch[1]}`;
  }

  const sshProtocolMatch = trimmed.match(
    /^ssh:\/\/git@github\.com\/(.+?)(?:\.git)?$/,
  );
  if (sshProtocolMatch) {
    return `https://github.com/${sshProtocolMatch[1]}`;
  }

  const httpsMatch = trimmed.match(/^https:\/\/github\.com\/(.+?)(?:\.git)?$/);
  if (httpsMatch) {
    return `https://github.com/${httpsMatch[1]}`;
  }

  throw new DubError(
    `Remote URL '${trimmed}' does not point to GitHub. 'dub repo' currently supports GitHub remotes only.`,
    [
      "Run 'git remote -v' to inspect configured remotes.",
      "Run 'git remote set-url origin <github-url>' to point the remote at GitHub.",
    ],
  );
}
