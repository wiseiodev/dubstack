import * as fs from 'node:fs';
import * as path from 'node:path';
import { DubError } from '../lib/errors';
import { getRepoRoot, isGitRepo } from '../lib/git';

/**
 * Inlined copy of the `retarget-action.yml` workflow template. The source of
 * truth lives at `packages/cli/src/templates/retarget-action.yml` (committed
 * for human review); a unit test asserts the two stay in sync so contributors
 * always see the same content the CLI writes.
 *
 * Embedding the template as a string lets the bundled CLI ship a single
 * `dist/index.js` without needing tsup to copy asset files.
 */
export const RETARGET_ACTION_TEMPLATE = `name: Dubstack stack retarget
on:
  pull_request:
    types: [closed]
permissions:
  contents: read
  pull-requests: write
jobs:
  retarget:
    if: github.event.pull_request.merged == true
    runs-on: ubuntu-latest
    steps:
      - uses: wiseiodev/dubstack-retarget@v1
        with:
          github-token: \${{ secrets.GITHUB_TOKEN }}
`;

export type InstallRecipe = 'retarget-action';

export interface InstallOptions {
  dryRun?: boolean;
  force?: boolean;
  /**
   * Test seam for the confirm prompt. The CLI wiring supplies an inquirer-
   * backed implementation; tests pass a deterministic stub.
   */
  confirm?: (message: string) => Promise<boolean>;
}

export type InstallResult =
  | { status: 'installed'; path: string }
  | { status: 'already-installed'; path: string }
  | { status: 'preview'; path: string; content: string }
  | { status: 'cancelled'; path: string }
  | { status: 'overwritten'; path: string };

/**
 * Maps a recipe name to its `{ relativePath, content }` pair. Future recipes
 * (DUB-73 webhook, etc.) plug in here without touching the install wiring.
 */
function resolveRecipe(recipe: InstallRecipe): {
  relativePath: string;
  content: string;
} {
  switch (recipe) {
    case 'retarget-action':
      return {
        relativePath: '.github/workflows/dubstack-retarget.yml',
        content: RETARGET_ACTION_TEMPLATE,
      };
    default: {
      const _exhaustive: never = recipe;
      throw new DubError(`Unknown install recipe: ${String(_exhaustive)}.`, [
        "Run 'dub install --help' to see available recipes.",
      ]);
    }
  }
}

/**
 * Writes a Dubstack recipe (currently just `retarget-action`) into the
 * current repo. Confirms before overwriting an existing file with different
 * content unless `--force`. With `--dry-run`, returns the planned write
 * without touching disk.
 */
export async function install(
  cwd: string,
  recipe: InstallRecipe,
  options: InstallOptions = {},
): Promise<InstallResult> {
  if (!(await isGitRepo(cwd))) {
    throw new DubError('Not a git repository.', [
      "Run 'git init' in the desired project directory.",
      "Run 'cd <repo>' to switch into an existing git repository, then rerun 'dub install'.",
    ]);
  }

  const { relativePath, content } = resolveRecipe(recipe);
  const repoRoot = await getRepoRoot(cwd);
  const target = path.join(repoRoot, relativePath);

  if (options.dryRun) {
    return { status: 'preview', path: target, content };
  }

  if (fs.existsSync(target)) {
    const existing = fs.readFileSync(target, 'utf-8');
    if (existing === content) {
      return { status: 'already-installed', path: target };
    }
    if (!options.force) {
      const confirmed = options.confirm
        ? await options.confirm(
            `'${relativePath}' already exists with different content. Overwrite?`,
          )
        : false;
      if (!confirmed) {
        return { status: 'cancelled', path: target };
      }
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    return { status: 'overwritten', path: target };
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return { status: 'installed', path: target };
}
