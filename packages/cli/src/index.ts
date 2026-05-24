#!/usr/bin/env node

/**
 * DubStack CLI — manage stacked diffs with ease.
 *
 * A local-first tool for managing chains of dependent git branches
 * (stacked diffs) without manually dealing with complex rebase chains.
 *
 * @example
 * ```bash
 * dub init                    # Initialize in current repo
 * dub create feat/my-branch   # Create stacked branch
 * dub log                     # View stack tree
 * dub restack                 # Rebase stack onto updated parent
 * dub undo                    # Undo last dub operation
 * ```
 *
 * @packageDocumentation
 */

import { createRequire } from 'node:module';
import chalk, { Chalk } from 'chalk';
import { Command } from 'commander';
import { abortCommand } from './commands/abort';
import { branchInfoOutput } from './commands/branch';
import {
  checkout,
  interactiveCheckout,
  resolveCheckoutTrunk,
} from './commands/checkout';
import { children } from './commands/children';
import { continueCommand } from './commands/continue';
import { create } from './commands/create';
import { deleteCommand } from './commands/delete';
import { docs } from './commands/docs';
import { doctor } from './commands/doctor';
import { flow } from './commands/flow';
import { fold } from './commands/fold';
import { init } from './commands/init';
import { log, logJson, styleLogOutput } from './commands/log';
import { mcp } from './commands/mcp';
import { mergeCheck } from './commands/merge-check';
import { mergeNext } from './commands/merge-next';
import { move } from './commands/move';
import { bottom, downBySteps, top, upBySteps } from './commands/navigate';
import { parent } from './commands/parent';
import { postMerge } from './commands/post-merge';
import { pr } from './commands/pr';
import { prune } from './commands/prune';
import { ready } from './commands/ready';
import { rename } from './commands/rename';
import { repo } from './commands/repo';
import { restack, restackContinue } from './commands/restack';
import { formatStatus, status } from './commands/status';
import type { SubmitPathMode, SubmitScope } from './commands/submit';
import { submit } from './commands/submit';
import { sync } from './commands/sync';
import { track } from './commands/track';
import { trunk } from './commands/trunk';
import { undo } from './commands/undo';
import { untrack } from './commands/untrack';
import { watch } from './commands/watch';
import {
  collectKnownTopLevelCommands,
  preprocessCliArgs,
  promptTypoResolution,
  type ShortcutMetadata,
} from './lib/ai-shortcut';
import { readConfig } from './lib/config';
import { DubError, formatDubError } from './lib/errors';
import { getCurrentBranch } from './lib/git';
import {
  appendHistoryEntry,
  normalizeHistoryLine,
  redactSensitiveText,
  sanitizeCommandArgs,
} from './lib/history';
import { detectActiveOperation } from './lib/operation-state';
import { setVerbose } from './lib/progress';
import {
  resolveRestackConflictDecision,
  restackConflictPrompt,
} from './lib/restack-conflict-prompt';
import { rollbackRestack } from './lib/restack-rollback';
import { parseScope, type ScopeMode } from './lib/scope';
import { getStackOverviewBatch } from './lib/stack-overview';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

const program = new Command();

async function showInfo(
  branch: string | undefined,
  options: { diff?: boolean },
): Promise<void> {
  console.log(
    await branchInfoOutput(process.cwd(), branch, { diff: options.diff }),
  );
}

program
  .name('dub')
  .description('Manage stacked diffs (dependent git branches) with ease')
  .version(version)
  .option(
    '--verbose',
    'Print each git/gh subprocess before running (sanitized of secrets)',
  )
  .addHelpText(
    'after',
    `
Examples:
  $ dub "what changed in this stack?"    Ask AI directly
  $ dub --ai "summarize terminal work"   Force AI shortcut mode`,
  );

program
  .command('init')
  .description('Initialize DubStack in the current git repository')
  .addHelpText(
    'after',
    `
Examples:
  $ dub init    Initialize DubStack, creating .git/dubstack/ and updating .gitignore`,
  )
  .action(async () => {
    const result = await init(process.cwd());
    if (result.status === 'created') {
      console.log(chalk.green('✔ DubStack initialized'));
    } else {
      console.log(chalk.yellow('⚠ DubStack already initialized'));
    }
  });

program
  .command('docs')
  .description('Open the DubStack docs website in your browser')
  .addHelpText(
    'after',
    `
Examples:
  $ dub docs    Open the DubStack docs website`,
  )
  .action(async () => {
    await docs();
  });

program
  .command('repo')
  .description('Open the current repository GitHub page in your browser')
  .addHelpText(
    'after',
    `
Examples:
  $ dub repo    Open the current repository GitHub page`,
  )
  .action(async () => {
    await repo(process.cwd());
  });

program
  .command('create')
  .argument('[branch-name]', 'Name of the new branch to create')
  .description('Create a new branch stacked on top of the current branch')
  .option('-m, --message <message>', 'Commit staged changes with this message')
  .option(
    '-a, --all',
    'Stage all changes before committing (requires -m or --ai)',
  )
  .option(
    '-u, --update',
    'Stage tracked file updates before committing (requires -m or --ai)',
  )
  .option(
    '-p, --patch',
    'Pick hunks to stage before committing (requires -m or --ai)',
  )
  .option(
    '-i, --ai',
    'AI-generate branch + conventional commit from staged changes',
  )
  .option('--no-ai', 'Disable AI generation for this invocation')
  .addHelpText(
    'after',
    `
Examples:
  $ dub create feat/api                       Create branch only
  $ dub create feat/api -m "feat: add API"    Create branch + commit staged
  $ dub create feat/api -am "feat: add API"   Stage all + create + commit
  $ dub create --ai                            AI-generate branch + commit from staged
  $ dub create --no-ai feat/api                Override repo AI defaults for one create`,
  )
  .action(
    async (
      branchName: string | undefined,
      options: {
        message?: string;
        all?: boolean;
        update?: boolean;
        patch?: boolean;
        ai?: boolean;
        noAi?: boolean;
      },
    ) => {
      const result = await create(branchName, process.cwd(), {
        message: options.message,
        all: options.all,
        update: options.update,
        patch: options.patch,
        ai: options.ai,
        noAi: options.noAi,
      });
      if (result.committed) {
        console.log(
          chalk.green(
            `✔ Created '${result.branch}' on '${result.parent}' • ${result.committed}`,
          ),
        );
      } else {
        console.log(
          chalk.green(
            `✔ Created branch '${result.branch}' on top of '${result.parent}'`,
          ),
        );
      }
    },
  );

program
  .command('flow')
  .alias('f')
  .description(
    'Stage, preview, create, and submit an AI-assisted DubStack change',
  )
  .option('-a, --all', 'Stage all changes before generating metadata')
  .option(
    '-u, --update',
    'Stage tracked file changes before generating metadata',
  )
  .option('-p, --patch', 'Pick hunks to stage before generating metadata')
  .option('-y, --yes', 'Auto-approve generated metadata without prompting')
  .option('-i, --ai', 'Force AI flow for this invocation')
  .option('--no-ai', 'Disable AI flow for this invocation')
  .option(
    '--dry-run',
    'Preview generated metadata without creating or submitting',
  )
  .addHelpText(
    'after',
    `
Examples:
  $ dub flow --ai -a      Stage all, preview AI metadata, create, and submit
  $ dub flow -y -u        Auto-approve after staging tracked changes
  $ dub flow --dry-run    Preview generated branch, commit, and PR text only`,
  )
  .action(runFlow);

program
  .command('log')
  .alias('l')
  .description('Display an ASCII tree of the current stack')
  .option('-s, --stack', 'Only show the current stack')
  .option('-a, --all', 'Show all stacks (default)')
  .option('-r, --reverse', 'Reverse stack/child ordering')
  .option('--json', 'Output the stack tree as JSON')
  .option('--no-prs', 'Hide PR-state annotations in the rich view')
  .option('--no-ci', 'Hide CI-state annotations in the rich view')
  .option('--refresh', 'Bust the 30-second overview cache before rendering')
  .option(
    '--no-color',
    'Disable ANSI colors; keep `*` (current) and `>` (ancestor) text markers, strip `~` sibling markers',
  )
  .addHelpText(
    'after',
    `
Examples:
  $ dub log    Show the branch tree with current branch highlighted`,
  )
  .action(
    async (options: {
      stack?: boolean;
      all?: boolean;
      reverse?: boolean;
      json?: boolean;
      color?: boolean;
      prs?: boolean;
      ci?: boolean;
      refresh?: boolean;
    }) => {
      await printLog(process.cwd(), options);
    },
  );

program
  .command('ls')
  .description('Display an ASCII tree of the current stack')
  .option('-s, --stack', 'Only show the current stack')
  .option('-a, --all', 'Show all stacks (default)')
  .option('-r, --reverse', 'Reverse stack/child ordering')
  .option('--json', 'Output the stack tree as JSON')
  .option('--no-prs', 'Hide PR-state annotations in the rich view')
  .option('--no-ci', 'Hide CI-state annotations in the rich view')
  .option('--refresh', 'Bust the 30-second overview cache before rendering')
  .option(
    '--no-color',
    'Disable ANSI colors; keep `*` (current) and `>` (ancestor) text markers, strip `~` sibling markers',
  )
  .action(
    async (options: {
      stack?: boolean;
      all?: boolean;
      reverse?: boolean;
      json?: boolean;
      color?: boolean;
      prs?: boolean;
      ci?: boolean;
      refresh?: boolean;
    }) => {
      await printLog(process.cwd(), options);
    },
  );

program
  .command('up')
  .argument('[steps]', 'Number of levels to traverse upstack')
  .option('-n, --steps <count>', 'Number of levels to traverse upstack')
  .description('Checkout the child branch directly above the current branch')
  .action(async (stepsArg: string | undefined, options: { steps?: string }) => {
    const steps = parseSteps(stepsArg, options.steps);
    const result = await upBySteps(process.cwd(), steps);
    if (result.changed) {
      console.log(chalk.green(`✔ Switched up to '${result.branch}'`));
    } else {
      console.log(chalk.yellow(`⚠ Already at top branch '${result.branch}'`));
    }
  });

program
  .command('down')
  .argument('[steps]', 'Number of levels to traverse downstack')
  .option('-n, --steps <count>', 'Number of levels to traverse downstack')
  .description('Checkout the parent branch directly below the current branch')
  .action(async (stepsArg: string | undefined, options: { steps?: string }) => {
    const steps = parseSteps(stepsArg, options.steps);
    const result = await downBySteps(process.cwd(), steps);
    if (result.changed) {
      console.log(chalk.green(`✔ Switched down to '${result.branch}'`));
    } else {
      console.log(
        chalk.yellow(`⚠ Already at bottom branch '${result.branch}'`),
      );
    }
  });

program
  .command('top')
  .description('Checkout the topmost branch in the current stack path')
  .action(async () => {
    const result = await top(process.cwd());
    if (result.changed) {
      console.log(chalk.green(`✔ Switched to top branch '${result.branch}'`));
    } else {
      console.log(chalk.yellow(`⚠ Already at top branch '${result.branch}'`));
    }
  });

program
  .command('bottom')
  .description(
    'Checkout the first branch above the root in the current stack path',
  )
  .action(async () => {
    const result = await bottom(process.cwd());
    if (result.changed) {
      console.log(
        chalk.green(`✔ Switched to bottom stack branch '${result.branch}'`),
      );
    } else {
      console.log(
        chalk.yellow(`⚠ Already at bottom stack branch '${result.branch}'`),
      );
    }
  });

program
  .command('branch')
  .description('Show DubStack branch metadata')
  .addCommand(
    new Command('info')
      .description('Show tracked stack info for the current branch')
      .argument('[branch]', 'Branch to inspect (defaults to current branch)')
      .option('-d, --diff', 'Show the parent-relative git diff for the branch')
      .action(showInfo),
  );

program
  .command('info')
  .argument('[branch]', 'Branch to inspect (defaults to current branch)')
  .option('-d, --diff', 'Show the parent-relative git diff for the branch')
  .description('Show tracked stack info for a branch')
  .action(showInfo);

program
  .command('track')
  .argument('[branch]', 'Branch to track (defaults to current branch)')
  .option('-p, --parent <branch>', 'Parent branch for tracking')
  .option(
    '--no-interactive',
    'Disable parent prompt and require deterministic behavior',
  )
  .description('Track a branch or update its parent relationship')
  .addHelpText(
    'after',
    `
Examples:
  $ dub track
  $ dub track feat/a --parent main`,
  )
  .action(
    async (
      branch: string | undefined,
      options: { parent?: string; interactive?: boolean },
    ) => {
      const result = await track(process.cwd(), branch, {
        parent: options.parent,
        interactive: options.interactive,
      });
      if (result.status === 'tracked') {
        console.log(
          chalk.green(`✔ Tracking '${result.branch}' on '${result.parent}'`),
        );
        return;
      }
      if (result.status === 'reparented') {
        console.log(
          chalk.green(
            `✔ Re-parented '${result.branch}' onto '${result.parent}'`,
          ),
        );
        console.log(
          chalk.dim(
            "  Run 'dub restack' if descendant branches now need rebasing.",
          ),
        );
        return;
      }
      console.log(
        chalk.yellow(
          `⚠ '${result.branch}' is already tracked on '${result.parent}'.`,
        ),
      );
    },
  );

program
  .command('untrack')
  .argument('[branch]', 'Branch to untrack (defaults to current branch)')
  .option('--downstack', 'Also untrack descendants recursively')
  .option('--no-interactive', 'Disable prompts and require explicit flags')
  .description(
    'Remove branch metadata from DubStack without deleting git branches',
  )
  .addHelpText(
    'after',
    `
Examples:
  $ dub untrack
  $ dub untrack feat/a --downstack`,
  )
  .action(
    async (
      branch: string | undefined,
      options: { downstack?: boolean; interactive?: boolean },
    ) => {
      const result = await untrack(process.cwd(), branch, {
        downstack: options.downstack,
        interactive: options.interactive,
      });
      console.log(
        chalk.green(
          `✔ Untracked ${result.removed.length} branch(es): ${result.removed.join(', ')}`,
        ),
      );
      for (const entry of result.reparented) {
        console.log(
          chalk.dim(
            `  ↳ Re-parented '${entry.branch}' to '${entry.parent ?? '(none)'}'`,
          ),
        );
      }
    },
  );

program
  .command('delete')
  .argument('[branch]', 'Branch to delete (defaults to current branch)')
  .option('--upstack', 'Also delete descendants of the target branch')
  .option('--downstack', 'Also delete ancestors toward trunk')
  .option('-f, --force', 'Delete branches even when not merged')
  .option('-q, --quiet', 'Skip confirmation prompts')
  .option('--no-interactive', 'Disable prompts and require explicit flags')
  .description('Delete local branches and update DubStack metadata')
  .addHelpText(
    'after',
    `
Examples:
  $ dub delete feat/a
  $ dub delete feat/a --upstack -f -q`,
  )
  .action(
    async (
      branch: string | undefined,
      options: {
        upstack?: boolean;
        downstack?: boolean;
        force?: boolean;
        quiet?: boolean;
        interactive?: boolean;
      },
    ) => {
      const result = await deleteCommand(process.cwd(), branch, {
        upstack: options.upstack,
        downstack: options.downstack,
        force: options.force,
        quiet: options.quiet,
        interactive: options.interactive,
      });
      if (result.cancelled) {
        console.log(chalk.yellow('⚠ Delete cancelled.'));
        return;
      }
      console.log(
        chalk.green(
          `✔ Deleted ${result.deleted.length} branch(es): ${result.deleted.join(', ')}`,
        ),
      );
      for (const entry of result.reparented) {
        console.log(
          chalk.dim(
            `  ↳ Re-parented '${entry.branch}' to '${entry.parent ?? '(none)'}'`,
          ),
        );
      }
    },
  );

program
  .command('fold')
  .description(
    'Combine the current branch into its parent, re-parenting children',
  )
  .option('-f, --force', 'Skip the deletion confirmation prompt')
  .option(
    '--squash',
    'Collapse the branch into one commit on the parent (default keeps commits)',
  )
  .option(
    '--keep-commits',
    'Preserve commits as separate commits on the parent (default)',
  )
  .option('--no-interactive', 'Disable prompts and require --force')
  .addHelpText(
    'after',
    `
Examples:
  $ dub fold                Fold current branch into parent (keeps commits)
  $ dub fold --squash       Collapse current branch into a single commit on parent
  $ dub fold --force        Skip the confirmation prompt`,
  )
  .action(
    async (options: {
      force?: boolean;
      squash?: boolean;
      keepCommits?: boolean;
      interactive?: boolean;
    }) => {
      if (options.squash && options.keepCommits) {
        throw new DubError(
          "'--squash' cannot be combined with '--keep-commits'.",
          [
            "Pass '--squash' alone to collapse commits into one on the parent.",
            "Pass '--keep-commits' (or omit both) to preserve individual commits.",
          ],
        );
      }
      const result = await fold(process.cwd(), {
        force: options.force,
        squash: options.squash,
        interactive: options.interactive,
      });
      if (result.cancelled) {
        console.log(chalk.yellow('⚠ Fold cancelled.'));
        return;
      }
      const summary = options.squash
        ? `squashed ${result.squashedCommits} commit(s)`
        : `kept ${result.squashedCommits} commit(s)`;
      console.log(
        chalk.green(
          `✔ Folded '${result.branch}' into '${result.parent}' (${summary})`,
        ),
      );
      if (result.childrenReparented.length > 0) {
        console.log(
          chalk.dim(
            `  ↳ Re-parented ${result.childrenReparented.length} child(ren): ${result.childrenReparented.join(', ')}`,
          ),
        );
      }
      if (result.restacked) {
        console.log(chalk.dim('  ↳ Restacked descendants'));
      }
      if (result.prClosed) {
        console.log(chalk.dim(`  ↳ Closed PR #${result.prNumber}`));
      } else if (
        result.prNumber != null &&
        result.prPriorState &&
        result.prPriorState !== 'OPEN'
      ) {
        console.log(
          chalk.dim(
            `  ↳ PR #${result.prNumber} already ${result.prPriorState.toLowerCase()}; left untouched`,
          ),
        );
      }
    },
  );

program
  .command('move')
  .argument('<branch>', 'Branch to move within the stack')
  .option('--before <target>', 'Insert <branch> as the new parent of <target>')
  .option('--after <target>', 'Insert <branch> as the new child of <target>')
  .description(
    'Reorder a tracked branch within its stack (insert before or after another branch)',
  )
  .addHelpText(
    'after',
    `
Examples:
  $ dub move feat/inserted --before feat/auth-login    Insert before <target>
  $ dub move feat/inserted --after feat/auth-base      Insert after <target>`,
  )
  .action(
    async (branch: string, options: { before?: string; after?: string }) => {
      const result = await move(process.cwd(), branch, options);
      if (result.noOp) {
        console.log(
          chalk.yellow(
            `⚠ Nothing to do: ${result.noOpReason ?? 'branch already in requested position'}.`,
          ),
        );
        return;
      }
      if (result.conflictBranch) {
        console.log(
          chalk.green(
            `✔ Moved '${result.branch}' ${result.position} '${result.target}'`,
          ),
        );
        console.log(
          chalk.yellow(
            `⚠ Conflict while restacking '${result.conflictBranch}'`,
          ),
        );
        console.log(
          chalk.dim(
            '  Resolve conflicts, stage changes, then run: dub continue --ai (or dub restack --continue)',
          ),
        );
        return;
      }
      console.log(
        chalk.green(
          `✔ Moved '${result.branch}' ${result.position} '${result.target}' (new parent: '${result.newParent}')`,
        ),
      );
      if (result.retargeted.length > 0) {
        console.log(
          chalk.dim(`  ↳ retargeted PRs: ${result.retargeted.join(', ')}`),
        );
      }
      if (result.rebased.length > 0) {
        console.log(chalk.dim(`  ↳ rebased: ${result.rebased.join(', ')}`));
      }
    },
  );

program
  .command('parent')
  .argument('[branch]', 'Branch to inspect (defaults to current branch)')
  .description('Show the direct parent branch')
  .action(async (branch?: string) => {
    const result = await parent(process.cwd(), branch);
    console.log(result.parent);
  });

program
  .command('children')
  .argument('[branch]', 'Branch to inspect (defaults to current branch)')
  .description('Show direct child branches')
  .action(async (branch?: string) => {
    const result = await children(process.cwd(), branch);
    if (result.children.length === 0) {
      console.log('(none)');
      return;
    }
    for (const child of result.children) {
      console.log(child);
    }
  });

program
  .command('trunk')
  .argument('[branch]', 'Branch to inspect (defaults to current branch)')
  .description('Show trunk/root branch for the active stack')
  .action(async (branch?: string) => {
    const result = await trunk(process.cwd(), branch);
    console.log(result.trunk);
  });

program
  .command('watch')
  .description(
    'Long-lived monitor: polls GitHub + watches .git for stack-state changes',
  )
  .option(
    '--interval <duration>',
    'Poll interval — duration like 30s, 2m (default 60s)',
  )
  .option('--ui', 'Render the live TUI status pane')
  .addHelpText(
    'after',
    `
Examples:
  $ dub watch                     Start watcher with default 60s interval
  $ dub watch --interval 30s      Poll GitHub every 30 seconds
  $ dub watch --ui                Render live status pane`,
  )
  .action(async (options: { interval?: string; ui?: boolean }) => {
    await watch(process.cwd(), options);
  });

program
  .command('sync')
  .description('Sync tracked branches with remote and reconcile divergence')
  .option(
    '--restack',
    'Restack branches after sync (disable with --no-restack)',
    true,
  )
  .option(
    '-f, --force',
    'Skip prompts for branch reset/reconcile sync decisions',
  )
  .option('-a, --all', 'Sync all tracked stacks across trunks')
  .option('--no-interactive', 'Disable prompts and use deterministic behavior')
  .option(
    '--fresh',
    'Force a full fetch of every tracked branch (skip 5-minute freshness cache)',
  )
  .action(
    async (options: {
      restack?: boolean;
      force?: boolean;
      all?: boolean;
      interactive?: boolean;
      fresh?: boolean;
    }) => {
      await sync(process.cwd(), options);
    },
  );

program
  .command('restack')
  .description('Rebase all branches in the stack onto their updated parents')
  .option('--continue', 'Continue restacking after resolving conflicts')
  .addHelpText(
    'after',
    `
Examples:
  $ dub restack              Rebase the current stack
  $ dub restack --continue   Continue after resolving conflicts`,
  )
  .action(async (options: { continue?: boolean }) => {
    const result = options.continue
      ? await restackContinue(process.cwd())
      : await restack(process.cwd());

    if (result.status === 'up-to-date') {
      console.log(chalk.green('✔ Stack is already up to date'));
    } else if (result.status === 'conflict') {
      const interactive = Boolean(process.stdout.isTTY && process.stdin.isTTY);
      const conflictBranch = result.conflictBranch ?? 'unknown';
      const decision = await resolveRestackConflictDecision({
        branch: conflictBranch,
        interactive,
        promptChoice: (branchName) =>
          restackConflictPrompt({ branch: branchName }),
      });
      if (decision === 'cancel') {
        const rollback = await rollbackRestack(process.cwd());
        console.log(
          chalk.green(
            `✔ Rolled back ${rollback.branchesRestored} branch(es) to pre-restack state.`,
          ),
        );
        return;
      }
      if (decision === 'exit') {
        console.log(
          chalk.yellow(
            `⚠ Restack left in its current state on '${conflictBranch}'.`,
          ),
        );
        console.log(
          chalk.dim(
            '  Run: dub continue (or dub continue --ai), or dub abort to roll back.',
          ),
        );
        return;
      }
      console.log(
        chalk.yellow(`⚠ Conflict while restacking '${conflictBranch}'`),
      );
      console.log(
        chalk.dim(
          '  Resolve conflicts, stage changes, then run: dub continue --ai (or dub restack --continue)',
        ),
      );
    } else {
      console.log(
        chalk.green(`✔ Restacked ${result.rebased.length} branch(es)`),
      );
      for (const branch of result.rebased) {
        console.log(chalk.dim(`  ↳ ${branch}`));
      }
    }
  });

program
  .command('continue')
  .description('Continue the active restack or git rebase operation')
  .option('--ai', 'Use AI to resolve conflicts before continuing')
  .action(async (options: { ai?: boolean }) => {
    const result = await continueCommand(process.cwd(), { ai: options.ai });
    if (result.continued === 'ai-resolve') {
      return;
    }
    if (result.continued === 'rebase') {
      console.log(chalk.green('✔ Continued git rebase.'));
      return;
    }
    if (result.restackResult?.status === 'conflict') {
      console.log(
        chalk.yellow(
          `⚠ Conflict while restacking '${result.restackResult.conflictBranch}'`,
        ),
      );
      console.log(
        chalk.dim(
          '  Resolve conflicts, stage changes, then run: dub continue --ai (or dub continue)',
        ),
      );
      return;
    }
    if (result.restackResult?.status === 'up-to-date') {
      console.log(chalk.green('✔ Stack is already up to date.'));
      return;
    }
    console.log(chalk.green('✔ Continued restack.'));
  });

program
  .command('abort')
  .description('Abort the active restack or git rebase operation')
  .action(async () => {
    const result = await abortCommand(process.cwd());
    if (result.aborted === 'restack') {
      console.log(chalk.green('✔ Aborted restack and cleared progress.'));
      return;
    }
    console.log(chalk.green('✔ Aborted git rebase.'));
  });

program
  .command('undo')
  .description('Undo the last dub create, dub restack, or dub rename operation')
  .addHelpText(
    'after',
    `
Examples:
  $ dub undo    Roll back the last dub operation`,
  )
  .action(async () => {
    const result = await undo(process.cwd());
    console.log(chalk.green(`✔ Undid '${result.undone}': ${result.details}`));
  });

program
  .command('submit')
  .description(
    'Push branches and create/update GitHub PRs for the current stack',
  )
  .option('--dry-run', 'Print what would happen without executing')
  .option('-i, --ai', 'AI-generate a PR description for this invocation')
  .option('--no-ai', 'Disable AI PR description generation for this invocation')
  .option('--upstack', 'Submit current branch + all descendants')
  .option('--downstack', 'Submit current branch + ancestors to trunk (default)')
  .option('--stack', 'Submit the full tree from trunk')
  .option(
    '--branch <name>',
    'Submit exactly this one branch (no ancestors, no descendants)',
  )
  .option(
    '--path <mode>',
    "[deprecated] Use --downstack (for 'current') or --stack",
    parseSubmitPath,
  )
  .option('--fix', '[deprecated] No-op alias kept for script compatibility')
  .addHelpText(
    'after',
    `
Examples:
  $ dub submit              Push current branch + ancestors and create/update PRs (default)
  $ dub submit --upstack    Push current branch + all descendants
  $ dub submit --stack      Push every branch in the stack (trees supported)
  $ dub submit --branch foo Push only the 'foo' branch
  $ dub submit --dry-run    Preview what would happen
  $ dub submit --ai         Generate a PR description before updating the PR body`,
  )
  .action(runSubmit);

program
  .command('ss')
  .description('Submit the current stack (alias for submit)')
  .option('--dry-run', 'Print what would happen without executing')
  .option('-i, --ai', 'AI-generate a PR description for this invocation')
  .option('--no-ai', 'Disable AI PR description generation for this invocation')
  .option('--upstack', 'Submit current branch + all descendants')
  .option('--downstack', 'Submit current branch + ancestors to trunk (default)')
  .option('--stack', 'Submit the full tree from trunk')
  .option(
    '--branch <name>',
    'Submit exactly this one branch (no ancestors, no descendants)',
  )
  .option(
    '--path <mode>',
    "[deprecated] Use --downstack (for 'current') or --stack",
    parseSubmitPath,
  )
  .option('--fix', '[deprecated] No-op alias kept for script compatibility')
  .action(runSubmit);

program
  .command('merge-check')
  .description('Validate DubStack merge order for a PR or scoped set of PRs')
  .option('--pr <number>', 'PR number to validate', parsePositiveInt)
  .option('--branch <name>', 'Branch name to resolve PR from')
  .option(
    '--scope <mode>',
    'Validation scope when no --pr/--branch is given: current (default) | downstack | stack',
    parseScope,
    'current' as ScopeMode,
  )
  .addHelpText(
    'after',
    `
Examples:
  $ dub merge-check                       Check the current branch's PR
  $ dub merge-check --scope downstack     Check current branch + ancestors
  $ dub merge-check --scope stack         Check every branch in the stack
  $ dub merge-check --pr 123              Check a specific PR (scope ignored)`,
  )
  .action(
    async (options: { pr?: number; branch?: string; scope: ScopeMode }) => {
      const result = await mergeCheck(process.cwd(), {
        pr: options.pr,
        branch: options.branch,
        scope: options.scope,
      });
      if (result.branches.length <= 1) {
        console.log(chalk.green(`✔ Merge check passed: ${result.reason}`));
        return;
      }
      console.log(
        chalk.green(
          `✔ Merge check passed for ${result.branches.length} branch(es) (scope: ${result.scope})`,
        ),
      );
      for (const finding of result.branches) {
        const prLabel = finding.prNumber ? `PR #${finding.prNumber}` : 'no PR';
        console.log(
          chalk.dim(`  ↳ ${finding.branch} (${prLabel}): ${finding.reason}`),
        );
      }
    },
  );

program
  .command('post-merge')
  .description('Repair stack metadata and retarget remaining PRs after a merge')
  .option('-a, --all', 'Process all tracked stacks')
  .option('--dry-run', 'Preview post-merge actions without mutating state')
  .option(
    '--restack',
    'Restack remaining branches (disable with --no-restack)',
    true,
  )
  .option(
    '--submit',
    'Submit refreshed stack updates (disable with --no-submit)',
    true,
  )
  .action(
    async (options: {
      all?: boolean;
      dryRun?: boolean;
      restack?: boolean;
      submit?: boolean;
    }) => {
      const result = await postMerge(process.cwd(), options);
      const mode = result.dryRun ? 'dry-run' : 'applied';
      console.log(chalk.green(`✔ Post-merge ${mode} complete.`));
      if (result.cleaned.length > 0) {
        console.log(chalk.dim(`  cleaned: ${result.cleaned.join(', ')}`));
      }
      if (result.skipped.length > 0) {
        console.log(chalk.dim(`  skipped: ${result.skipped.join(', ')}`));
      }
      if (result.retargeted.length > 0) {
        console.log(chalk.dim(`  retargeted: ${result.retargeted.join(', ')}`));
      }
      if (result.restacked) {
        console.log(chalk.dim('  restack: complete'));
      }
      if (result.submitted) {
        console.log(
          chalk.dim(
            `  submit refreshed: ${result.submittedBranches.length} branch(es)`,
          ),
        );
      }
    },
  );

program
  .command('merge-next')
  .alias('land')
  .description('Merge the next safe PR in your current stack path')
  .option('--dry-run', 'Preview merge + post-merge actions')
  .option(
    '--method <method>',
    'Merge strategy: merge|squash|rebase',
    parseMergeMethod,
    'squash',
  )
  .option(
    '--restack',
    'Run post-merge restack (disable with --no-restack)',
    true,
  )
  .option(
    '--submit',
    'Run post-merge submit refresh (disable with --no-submit)',
    true,
  )
  .action(
    async (options: {
      dryRun?: boolean;
      method?: 'merge' | 'squash' | 'rebase';
      restack?: boolean;
      submit?: boolean;
    }) => {
      const result = await mergeNext(process.cwd(), options);
      const printSiblingHint = () => {
        if (result.siblingCandidates.length > 0) {
          console.log(
            chalk.dim(
              `ℹ Other mergeable candidates at this stack level: ${result.siblingCandidates.join(', ')}`,
            ),
          );
          console.log(
            chalk.dim(
              "   Switch with 'dub co <branch>' and rerun 'dub merge-next'.",
            ),
          );
        }
        if (result.blockedSiblings.length > 0) {
          const summary = result.blockedSiblings
            .map(
              (s) =>
                `${s.branch} (PR #${s.prNumber}: ${s.mergeable}/${s.mergeStateStatus})`,
            )
            .join(', ');
          console.log(
            chalk.yellow(`⚠ Blocked siblings at this stack level: ${summary}`),
          );
        }
      };
      if (result.dryRun) {
        console.log(
          chalk.green(
            `✔ Dry-run: would merge '${result.mergedBranch}' (PR #${result.prNumber}).`,
          ),
        );
        if (result.preMergeRetargeted.length > 0) {
          console.log(
            chalk.dim(
              `  pre-merge retarget: ${result.preMergeRetargeted.join(', ')}`,
            ),
          );
        }
        printSiblingHint();
        return;
      }
      console.log(
        chalk.green(
          `✔ Merged '${result.mergedBranch}' (PR #${result.prNumber}) and ran post-merge maintenance.`,
        ),
      );
      if (result.preMergeRetargeted.length > 0) {
        console.log(
          chalk.dim(
            `  pre-merge retargeted: ${result.preMergeRetargeted.join(', ')}`,
          ),
        );
      }
      printSiblingHint();
    },
  );

program
  .command('doctor')
  .description('Run stack health checks and print actionable remediation steps')
  .option('-a, --all', 'Check all stacks instead of only the current stack')
  .option('--no-fetch', 'Skip remote fetch before remote drift checks')
  .action(async (options: { all?: boolean; fetch?: boolean }) => {
    const result = await doctor(process.cwd(), options);
    if (result.issues.length === 0) {
      console.log(
        chalk.green(`✔ No issues found for '${result.checkedBranch}'.`),
      );
      return;
    }
    console.log(
      chalk.yellow(
        `⚠ Found ${result.issues.length} issue(s) for '${result.checkedBranch}':`,
      ),
    );
    for (const issue of result.issues) {
      console.log(chalk.yellow(`• [${issue.code}] ${issue.summary}`));
      console.log(chalk.dim(`  ${issue.details}`));
      for (const fix of issue.fixes) {
        console.log(chalk.dim(`  ↳ ${fix}`));
      }
    }
  });

program
  .command('status')
  .description(
    'Print a one-line status snapshot or structured JSON for the current branch',
  )
  .option('--json', 'Output the status snapshot as JSON')
  .option('--live', 'Bypass the overview cache and hit gh fresh')
  .option('--no-pr', 'Skip PR fetch (for fast prompts without gh)')
  .addHelpText(
    'after',
    `
Examples:
  $ dub status                Print a one-line status (cache-only, fast)
  $ dub status --json         Emit structured JSON
  $ dub status --live         Refresh PR/CI data via gh
  $ dub status --no-pr        Skip the PR fetch (shell prompts without gh)`,
  )
  .action(async (options: { json?: boolean; live?: boolean; pr?: boolean }) => {
    const result = await status(process.cwd(), {
      live: options.live,
      pr: options.pr,
    });
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(formatStatus(result));
  });

program
  .command('ready')
  .description('Run health + submit preflight checks for the current branch')
  .option(
    '--scope <mode>',
    'Validation scope: current | downstack (default) | stack',
    parseScope,
    'downstack' as ScopeMode,
  )
  .addHelpText(
    'after',
    `
Examples:
  $ dub ready                    Check current branch + ancestors (downstack)
  $ dub ready --scope current    Check just the current branch
  $ dub ready --scope stack      Check every branch in the stack`,
  )
  .action(async (options: { scope: ScopeMode }) => {
    const result = await ready(process.cwd(), { scope: options.scope });
    console.log(chalk.dim(`Branch: ${result.checkedBranch}`));
    if (result.submitBranches.length > 0) {
      console.log(
        chalk.dim(
          `Submit scope (${result.scope}): ${result.submitBranches.join(' -> ')} (trunk: ${result.rootBranch})`,
        ),
      );
    }
    if (result.ready) {
      console.log(chalk.green('✔ Ready to submit.'));
      return;
    }
    console.log(chalk.yellow('⚠ Not ready to submit yet.'));
    for (const blocker of result.blockers) {
      console.log(chalk.yellow(`  - ${blocker}`));
    }
  });

program
  .command('prune')
  .description(
    'Preview or remove stale tracked branches from DubStack metadata',
  )
  .option('--apply', 'Apply pruning changes (default is preview only)')
  .option('-a, --all', 'Prune stale tracked branches across all stacks')
  .option('--no-fetch', 'Skip remote fetch before pruning checks')
  .action(
    async (options: { apply?: boolean; all?: boolean; fetch?: boolean }) => {
      const result = await prune(process.cwd(), options);
      if (result.stale.length === 0) {
        console.log(chalk.green('✔ No stale tracked branches found.'));
        return;
      }
      const modeLabel = result.applied ? 'applied' : 'preview';
      console.log(
        chalk.yellow(
          `⚠ Prune ${modeLabel}: ${result.stale.length} stale tracked branch(es) detected.`,
        ),
      );
      for (const entry of result.stale) {
        console.log(
          chalk.dim(
            `  ↳ ${entry.branch} (${entry.reason}; local=${entry.hasLocal}; remote=${entry.hasRemote})`,
          ),
        );
      }
      if (result.applied) {
        console.log(
          chalk.green(
            `✔ Removed ${result.removed.length} stale tracked branch(es): ${result.removed.join(', ')}`,
          ),
        );
      } else {
        console.log(
          chalk.dim("  Run 'dub prune --apply' to persist these removals."),
        );
      }
    },
  );

program
  .command('checkout')
  .alias('co')
  .argument('[branch]', 'Branch to checkout (interactive if omitted)')
  .option('-t, --trunk', 'Checkout the current trunk')
  .option(
    '-u, --show-untracked',
    'Include untracked branches in interactive selection',
  )
  .option(
    '-s, --stack',
    'Only show ancestors and descendants of current branch in interactive selection',
  )
  .option(
    '-a, --all',
    'Show branches across all tracked stacks in interactive selection',
  )
  .option(
    '--refresh',
    'Bypass the 30s PR/CI overview cache and refetch from GitHub',
  )
  .option('--no-color', 'Disable ANSI colors in the picker')
  .description('Checkout a branch (interactive picker if no name given)')
  .action(
    async (
      branch: string | undefined,
      options: {
        trunk?: boolean;
        showUntracked?: boolean;
        stack?: boolean;
        all?: boolean;
        refresh?: boolean;
        color?: boolean;
      },
    ) => {
      if (branch) {
        const result = await checkout(branch, process.cwd());
        console.log(chalk.green(`✔ Switched to '${result.branch}'`));
      } else if (options.trunk) {
        const trunk = await resolveCheckoutTrunk(process.cwd());
        const result = await checkout(trunk, process.cwd());
        console.log(chalk.green(`✔ Switched to '${result.branch}'`));
      } else {
        const result = await interactiveCheckout(process.cwd(), {
          showUntracked: options.showUntracked,
          stack: options.stack,
          all: options.all,
          refresh: options.refresh,
          noColor: options.color === false,
        });
        if (result) {
          console.log(chalk.green(`✔ Switched to '${result.branch}'`));
        }
      }
    },
  );

program
  .command('skills')
  .description('Manage DubStack agent skills')
  .addCommand(
    new Command('add')
      .description('Install agent skills (e.g. dubstack, dub-flow)')
      .argument('[skills...]', 'Names of skills to install (default: all)')
      .option('-g, --global', 'Install skills globally')
      .option('--dry-run', 'Preview actions without installing')
      .action(async (skills, options) => {
        const { addSkills } = await import('./commands/skills');
        await addSkills(skills, options);
      }),
  )
  .addCommand(
    new Command('remove')
      .description('Remove agent skills')
      .argument('[skills...]', 'Names of skills to remove (default: all)')
      .option('-g, --global', 'Remove skills globally')
      .option('--dry-run', 'Preview actions without removing')
      .action(async (skills, options) => {
        const { removeSkills } = await import('./commands/skills');
        await removeSkills(skills, options);
      }),
  );

program
  .command('config')
  .description('Manage DubStack configuration')
  .addCommand(
    new Command('ai-assistant')
      .argument('[state]', 'Set to on/off (omit to inspect current value)')
      .description('Enable or disable the repo-local AI assistant')
      .action(async (state?: string) => {
        const { configAiAssistant } = await import('./commands/config');
        const result = await configAiAssistant(process.cwd(), state);

        if (!state) {
          console.log(
            chalk.blue(
              `AI assistant is ${result.enabled ? 'enabled' : 'disabled'} for this repository.`,
            ),
          );
          return;
        }

        if (result.changed) {
          console.log(
            chalk.green(
              `✔ AI assistant ${result.enabled ? 'enabled' : 'disabled'}`,
            ),
          );
        } else {
          console.log(
            chalk.yellow(
              `⚠ AI assistant is already ${result.enabled ? 'enabled' : 'disabled'}`,
            ),
          );
        }
      }),
  )
  .addCommand(
    new Command('ai-defaults')
      .description('Manage repo-local AI defaults for DubStack commands')
      .argument('<target>', 'One of: create, submit, flow')
      .argument('[state]', 'Set to on/off (omit to inspect current value)')
      .action(async (target: 'create' | 'submit' | 'flow', state?: string) => {
        const { configAiDefaults } = await import('./commands/config');
        const result = await configAiDefaults(process.cwd(), target, state);

        if (!state) {
          console.log(
            chalk.blue(
              `AI default for '${target}' is ${result.enabled ? 'enabled' : 'disabled'} for this repository.`,
            ),
          );
          return;
        }

        if (result.changed) {
          console.log(
            chalk.green(
              `✔ AI default for '${target}' ${result.enabled ? 'enabled' : 'disabled'}`,
            ),
          );
        } else {
          console.log(
            chalk.yellow(
              `⚠ AI default for '${target}' is already ${result.enabled ? 'enabled' : 'disabled'}`,
            ),
          );
        }
      }),
  )
  .addCommand(
    new Command('ai-provider')
      .argument(
        '[provider]',
        'Set to auto/gemini/gateway/bedrock (omit to inspect current value)',
      )
      .description('Manage the repo-local AI provider selection')
      .action(async (provider?: string) => {
        const { configAiProvider } = await import('./commands/config');
        const result = await configAiProvider(process.cwd(), provider);

        if (!provider) {
          console.log(
            chalk.blue(
              `AI provider is '${result.provider}' for this repository.`,
            ),
          );
          return;
        }

        if (result.changed) {
          console.log(chalk.green(`✔ AI provider set to '${result.provider}'`));
        } else {
          console.log(
            chalk.yellow(`⚠ AI provider is already '${result.provider}'`),
          );
        }
      }),
  )
  .addCommand(
    new Command('mcp-mode')
      .argument(
        '[mode]',
        'Set to read-only/interactive/trusted (omit to inspect current value)',
      )
      .description(
        'Manage the security model for mutating MCP tool calls (default: interactive)',
      )
      .action(async (mode?: string) => {
        const { configMcpMode } = await import('./commands/config');
        const result = await configMcpMode(process.cwd(), mode);

        if (!mode) {
          console.log(
            chalk.blue(`MCP mode is '${result.mode}' for this repository.`),
          );
          return;
        }

        if (result.changed) {
          console.log(chalk.green(`✔ MCP mode set to '${result.mode}'`));
        } else {
          console.log(chalk.yellow(`⚠ MCP mode is already '${result.mode}'`));
        }
      }),
  )
  .addCommand(
    new Command('ai-model')
      .argument('[model]', 'Set repo-local model override (omit to inspect)')
      .requiredOption(
        '--provider <provider>',
        'Provider name: gemini, gateway, or bedrock',
      )
      .option('--clear', 'Clear the repo-local model override')
      .description('Manage repo-local AI model overrides by provider')
      .action(
        async (
          model: string | undefined,
          options: {
            provider: string;
            clear?: boolean;
          },
        ) => {
          const { configAiModel } = await import('./commands/config');
          const result = await configAiModel(
            process.cwd(),
            options.provider,
            model,
            {
              clear: options.clear,
            },
          );

          if (!options.clear && model == null) {
            console.log(
              chalk.blue(
                result.model
                  ? `AI model override for '${options.provider}' is '${result.model}' for this repository.`
                  : `AI model override for '${options.provider}' is not set for this repository.`,
              ),
            );
            return;
          }

          if (result.changed) {
            console.log(
              chalk.green(
                options.clear
                  ? `✔ Cleared AI model override for '${options.provider}'`
                  : `✔ AI model override for '${options.provider}' set to '${result.model}'`,
              ),
            );
          } else {
            console.log(
              chalk.yellow(
                options.clear
                  ? `⚠ AI model override for '${options.provider}' is already clear`
                  : `⚠ AI model override for '${options.provider}' is already '${result.model}'`,
              ),
            );
          }
        },
      ),
  );

program
  .command('ai')
  .description(
    'Use DubStack AI assistant utilities (or shortcut with: dub PROMPT)',
  )
  .addCommand(
    new Command('setup')
      .description('Guided setup for DubStack AI providers and model defaults')
      .action(async () => {
        const { aiSetup } = await import('./commands/ai-setup');
        const result = await aiSetup(process.cwd());

        console.log(chalk.green(`✔ AI setup updated for '${result.provider}'`));
        console.log(
          chalk.dim(`  ↳ model: ${result.model} (${result.modelScope})`),
        );
        if (result.updatedEnv.length > 0) {
          console.log(
            chalk.dim(`  ↳ updated env: ${result.updatedEnv.join(', ')}`),
          );
          if (result.profilePath) {
            console.log(chalk.dim(`  ↳ wrote profile: ${result.profilePath}`));
          }
          if (result.activationCommand) {
            console.log(
              chalk.dim(
                `  ↳ run in your shell to activate now: ${result.activationCommand}`,
              ),
            );
          }
        }
      }),
  )
  .addCommand(
    new Command('ask')
      .argument('<prompt...>', 'Prompt text to send to the AI assistant')
      .description('Ask DubStack AI assistant a question (explicit mode)')
      .action(async (promptParts: string[]) => {
        const { askAi } = await import('./commands/ai');
        if (!invocationMetadata.invocationMode) {
          invocationMetadata.invocationMode = 'explicit-ai';
        }
        const result = await askAi(promptParts.join(' '), process.cwd());
        invocationMetadata.webBrowsingRequested = result.webBrowsingRequested;
        invocationMetadata.webBrowsingUsed = result.webBrowsingUsed;
      }),
  )
  .addCommand(
    new Command('env')
      .description(
        'Write DubStack AI provider settings to your shell profile (macOS/Linux)',
      )
      .option('--gemini-key <key>', 'Set DUBSTACK_GEMINI_API_KEY')
      .option('--gateway-key <key>', 'Set DUBSTACK_AI_GATEWAY_API_KEY')
      .option('--gemini-model <model>', 'Set DUBSTACK_GEMINI_MODEL')
      .option('--gateway-model <model>', 'Set DUBSTACK_AI_GATEWAY_MODEL')
      .option('--bedrock-profile <profile>', 'Set DUBSTACK_BEDROCK_AWS_PROFILE')
      .option('--bedrock-region <region>', 'Set DUBSTACK_BEDROCK_AWS_REGION')
      .option('--bedrock-model <model>', 'Set DUBSTACK_BEDROCK_MODEL')
      .option(
        '--profile <path>',
        'Override target profile path (recommended for custom shells)',
      )
      .option(
        '--shell <shell>',
        'Shell name used for profile detection (zsh or bash)',
      )
      .action(
        async (options: {
          geminiKey?: string;
          gatewayKey?: string;
          geminiModel?: string;
          gatewayModel?: string;
          bedrockProfile?: string;
          bedrockRegion?: string;
          bedrockModel?: string;
          profile?: string;
          shell?: string;
        }) => {
          const { configureAiEnv } = await import('./commands/ai-env');
          const result = await configureAiEnv({
            geminiKey: options.geminiKey,
            gatewayKey: options.gatewayKey,
            geminiModel: options.geminiModel,
            gatewayModel: options.gatewayModel,
            bedrockProfile: options.bedrockProfile,
            bedrockRegion: options.bedrockRegion,
            bedrockModel: options.bedrockModel,
            profile: options.profile,
            shell: options.shell,
          });

          console.log(chalk.green(`✔ Updated ${result.profilePath}`));
          for (const key of result.updated) {
            console.log(chalk.dim(`  ↳ exported ${key}`));
          }
          console.log(
            chalk.dim(
              `Run in your shell to activate now: ${result.activationCommand}`,
            ),
          );
        },
      ),
  )
  .addCommand(
    new Command('resolve')
      .description(
        'AI-assisted conflict resolution for rebase/restack conflicts',
      )
      .option('--dry-run', 'Show proposed resolutions without applying')
      .option('--abort', 'Abort the active rebase/restack operation')
      .action(async (options: { dryRun?: boolean; abort?: boolean }) => {
        const { aiResolve } = await import('./commands/ai-resolve');
        await aiResolve(process.cwd(), {
          dryRun: options.dryRun,
          abort: options.abort,
        });
      }),
  );

program
  .command('history')
  .description('Show recent Dub command history')
  .option(
    '-n, --limit <count>',
    'Number of history entries to show',
    parsePositiveInt,
  )
  .option('--json', 'Output history as JSON')
  .action(async (options: { limit?: number; json?: boolean }) => {
    const { formatHistory, history } = await import('./commands/history');
    const result = await history(process.cwd(), {
      limit: options.limit ?? 20,
    });

    if (options.json) {
      console.log(JSON.stringify(result.entries, null, 2));
      return;
    }

    console.log(formatHistory(result));
  });

program
  .command('mcp')
  .description(
    'Start the DubStack MCP server over stdio (mutating tools gated by `dub config mcp-mode`)',
  )
  .action(async () => {
    await mcp(process.cwd(), { version });
  });

program
  .command('modify')
  .alias('m')
  .description(
    'Modify the current branch by amending commits or creating new ones',
  )
  .option('-a, --all', 'Stage all changes before committing')
  .option('-c, --commit', 'Create a new commit instead of amending')
  .option('-e, --edit', 'Open editor to edit the commit message')
  .option(
    '-m, --message <message>',
    'Message for the new or amended commit',
    (value: string, previous: string[] = []) => [...previous, value],
    [],
  )
  .option('-p, --patch', 'Pick hunks to stage before committing')
  .option('-u, --update', 'Stage all updates to tracked files')
  .option(
    '-v, --verbose',
    'Show staged diff before modify (repeat for unstaged diff too)',
    (_value: unknown, previous = 0) => previous + 1,
    0,
  )
  .option(
    '--interactive-rebase',
    'Start an interactive rebase on the branch commits',
  )
  // .option("--into <branch>", "Amend staged changes to the specified branch") // TODO: Implement --into
  // .option("--reset-author", "Set the author to the current user") // TODO: Implement --reset-author
  // .option("-v, --verbose", "Show unified diff") // TODO: Implement verbose
  .action(async (options) => {
    const { modify } = await import('./commands/modify');
    const normalizedOptions = {
      ...options,
      message:
        Array.isArray(options.message) && options.message.length === 1
          ? options.message[0]
          : options.message,
    };
    await modify(process.cwd(), normalizedOptions);
  });

program
  .command('pr')
  .argument('[branch]', 'Branch name or PR number to open')
  .description('Open a branch PR in your browser')
  .action(async (branch?: string) => {
    await pr(process.cwd(), branch);
  });

program
  .command('rename')
  .argument('<firstName>', 'New name (current branch) or old name')
  .argument('[secondName]', 'New name when renaming a specific tracked branch')
  .description(
    'Rename a tracked branch and propagate the change through state, children, and remote',
  )
  .option('--no-push', 'Skip pushing the renamed branch even if a PR exists')
  .addHelpText(
    'after',
    `
Examples:
  $ dub rename feat/new-name              Rename the current tracked branch
  $ dub rename feat/old feat/new          Rename a specific tracked branch
  $ dub rename --no-push feat/new-name    Rename without pushing the renamed branch`,
  )
  .action(
    async (
      firstName: string,
      secondName: string | undefined,
      options: { push?: boolean },
    ) => {
      const result = await rename(process.cwd(), firstName, secondName, {
        noPush: options.push === false,
      });
      console.log(
        chalk.green(`✔ Renamed '${result.oldName}' to '${result.newName}'`),
      );
      if (result.reparentedChildren.length > 0) {
        console.log(
          chalk.dim(
            `  ↳ Re-parented ${result.reparentedChildren.length} child branch(es): ${result.reparentedChildren.join(', ')}`,
          ),
        );
      }
      if (result.pushed && result.prNumber != null) {
        console.log(
          chalk.dim(
            `  ↳ Pushed '${result.newName}' to origin (PR #${result.prNumber} still points at '${result.oldName}' — GitHub doesn't allow editing a PR's head, so close it and rerun 'dub submit' to open a fresh PR on the renamed branch)`,
          ),
        );
      }
      if (result.oldRemoteCleanupHint) {
        console.log(
          chalk.dim(
            `  ℹ Old remote branch '${result.oldName}' may still exist. Run 'git push origin --delete ${result.oldName}' to clean it up.`,
          ),
        );
      }
    },
  );

async function runSubmit(options: {
  dryRun?: boolean;
  ai?: boolean;
  noAi?: boolean;
  path?: SubmitPathMode;
  upstack?: boolean;
  downstack?: boolean;
  stack?: boolean;
  branch?: string;
  fix?: boolean;
}) {
  const result = await submit(process.cwd(), options.dryRun ?? false, {
    ai: options.ai,
    noAi: options.noAi,
    path: options.path,
    upstack: options.upstack,
    downstack: options.downstack,
    stack: options.stack,
    branch: options.branch,
    fix: options.fix ?? false,
  });

  if (result.pushed.length > 0 && result.dryRun) {
    console.log(
      chalk.green(
        `✔ Dry-run complete (${describeScopeLabel(result.scope)}): would push ${result.pushed.length} branch(es) and check/create ${result.pushed.length} PR(s).`,
      ),
    );
    return;
  }

  if (result.pushed.length > 0) {
    console.log(
      chalk.green(
        `✔ Pushed ${result.pushed.length} branch(es), created ${result.created.length} PR(s), updated ${result.updated.length} PR(s)`,
      ),
    );
    for (const branch of [...result.created, ...result.updated]) {
      console.log(chalk.dim(`  ↳ ${branch}`));
    }
    return;
  }

  const scopeLabel = describeScopeLabel(result.scope);
  console.log(
    chalk.yellow(
      `⚠ Nothing to push for ${scopeLabel}. The selected scope contains no submittable branches.`,
    ),
  );
}

async function runFlow(options: {
  all?: boolean;
  update?: boolean;
  patch?: boolean;
  yes?: boolean;
  ai?: boolean;
  noAi?: boolean;
  dryRun?: boolean;
}) {
  const result = await flow(process.cwd(), {
    all: options.all,
    update: options.update,
    patch: options.patch,
    yes: options.yes,
    ai: options.ai,
    noAi: options.noAi,
    dryRun: options.dryRun,
  });

  if (result.aborted) {
    console.log(chalk.yellow('⚠ Flow cancelled before create/submit.'));
    return;
  }

  if (result.dryRun) {
    console.log(
      chalk.green(
        `✔ Dry-run complete: ${result.branch} • ${result.commitMessage}`,
      ),
    );
    return;
  }

  console.log(
    chalk.green(`✔ Flow complete: ${result.branch} • ${result.commitMessage}`),
  );
}

async function printLog(
  cwd: string,
  options: {
    stack?: boolean;
    all?: boolean;
    reverse?: boolean;
    json?: boolean;
    color?: boolean;
    prs?: boolean;
    ci?: boolean;
    refresh?: boolean;
  } = {},
) {
  const noColor = options.color === false || chalk.level === 0;
  // Best-effort: fetch the rich overview, but degrade silently to the plain
  // region-only tree when gh isn't authed, the network is down, or the
  // batch returns nothing. Failure here must never break `dub log`.
  let overview = null;
  try {
    overview = await getStackOverviewBatch(cwd, { refresh: options.refresh });
  } catch {
    overview = null;
  }

  const logOptions = {
    stack: options.stack,
    all: options.all,
    reverse: options.reverse,
    prs: options.prs,
    ci: options.ci,
    noColor,
    overview,
  };

  if (options.json) {
    console.log(JSON.stringify(await logJson(cwd, logOptions), null, 2));
    return;
  }

  const output = await log(cwd, logOptions);
  if (overview?.truncated && overview.branches.length > 0) {
    // Use a scoped Chalk instance keyed off the same noColor decision the
    // tree renderer honors — `chalk.yellow(...)` would otherwise still emit
    // ANSI under `--no-color` since noColor only affects styleLogOutput.
    const bannerChalk = noColor ? new Chalk({ level: 0 }) : chalk;
    console.log(
      bannerChalk.yellow(
        `ℹ Showing ${overview.branches.length}+ branches — some PR data may be stale.`,
      ),
    );
  }
  console.log(styleLogOutput(output, noColor));
}

function parseSteps(positional?: string, option?: string): number {
  const raw = option ?? positional;
  if (!raw) return 1;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new DubError('Steps must be a positive integer.', [
      "Pass '<n>' or '--steps <n>' as a positive integer (e.g. 'dub up 2').",
    ]);
  }
  return parsed;
}

function parseSubmitPath(value: string): SubmitPathMode {
  if (value === 'current' || value === 'stack') return value;
  throw new DubError("Submit path must be either 'current' or 'stack'.", [
    "Pass '--downstack' (replaces '--path current').",
    "Pass '--stack' (replaces '--path stack').",
  ]);
}

function describeScopeLabel(scope: SubmitScope): string {
  switch (scope.kind) {
    case 'stack':
      return 'stack';
    case 'upstack':
      return 'upstack';
    case 'downstack':
      return 'downstack';
    case 'branch':
      return `branch ${scope.branch}`;
  }
}

function parsePositiveInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new DubError('Expected a positive integer.', [
      'Pass a positive integer (1, 2, 3, ...) for this option.',
    ]);
  }
  return parsed;
}

function parseMergeMethod(value: string): 'merge' | 'squash' | 'rebase' {
  if (value === 'merge' || value === 'squash' || value === 'rebase') {
    return value;
  }
  throw new DubError('Merge method must be one of: merge, squash, rebase.', [
    "Pass one of: '--method merge', '--method squash', or '--method rebase'.",
  ]);
}

interface HistoryCaptureState {
  startedAt: number;
  command: string;
  output: string[];
  restore: () => void;
}

const MAX_HISTORY_OUTPUT_LINES = 120;
const MAX_HISTORY_OUTPUT_LINE_LENGTH = 500;
let historyCapture: HistoryCaptureState | null = null;
let historyArgsForCapture: string[] | null = null;
let invocationMetadata: ShortcutMetadata & {
  webBrowsingRequested?: boolean;
  webBrowsingUsed?: boolean;
} = {};

program.hook('preAction', () => {
  setVerbose(Boolean(program.opts().verbose));
  beginHistoryCapture();
});

program.hook('postAction', async () => {
  await finalizeHistoryCapture('success');
});

async function main() {
  try {
    const rawArgs = process.argv.slice(2);
    historyArgsForCapture = rawArgs;
    const knownCommands = collectKnownTopLevelCommands(program.commands);
    const config = await readConfig(process.cwd()).catch(() => null);
    const shortcutEnabled = config?.ai.shortcutFallback.enabled ?? true;
    const preprocessed =
      shortcutEnabled || rawArgs[0] === '--ai'
        ? await preprocessCliArgs(
            rawArgs,
            knownCommands,
            Boolean(process.stdin.isTTY && process.stdout.isTTY),
            promptTypoResolution,
          )
        : { finalArgs: rawArgs, metadata: {} };
    invocationMetadata = { ...preprocessed.metadata };
    process.argv = [
      process.argv[0],
      process.argv[1],
      ...preprocessed.finalArgs,
    ];

    await program.parseAsync(process.argv);
  } catch (error) {
    if (error instanceof DubError) {
      const [firstLine, ...rest] = formatDubError(error).split('\n');
      console.error(chalk.red(`✖ ${firstLine}`));
      for (const line of rest) {
        console.error(line);
      }
      await finalizeHistoryCapture('error', error.message);
      process.exit(1);
    }

    await finalizeHistoryCapture(
      'error',
      error instanceof Error ? error.message : 'Unknown error',
    );
    throw error;
  }
}

function beginHistoryCapture(): void {
  if (historyCapture) return;

  const captureArgs = historyArgsForCapture ?? process.argv.slice(2);
  const sanitizedArgs = sanitizeCommandArgs(captureArgs);
  if (sanitizedArgs.length === 0) return;
  if (sanitizedArgs[0] === 'mcp') return;

  const output: string[] = [];
  let stdoutBuffer = '';
  let stderrBuffer = '';
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  const captureLine = (line: string) => {
    const normalized = normalizeHistoryLine(line);
    if (normalized.length === 0) return;
    if (output.length >= MAX_HISTORY_OUTPUT_LINES) return;
    output.push(truncateHistoryLine(redactSensitiveText(normalized)));
  };

  const captureChunk = (
    chunk: string | Uint8Array,
    stream: 'stdout' | 'stderr',
  ) => {
    const value =
      typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    const next = `${stream === 'stdout' ? stdoutBuffer : stderrBuffer}${value}`;
    const lines = next.split('\n');
    const remainder = lines.pop() ?? '';

    for (const line of lines) {
      if (line.length > 0) {
        captureLine(line);
      }
    }

    if (stream === 'stdout') {
      stdoutBuffer = remainder;
    } else {
      stderrBuffer = remainder;
    }
  };

  process.stdout.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    captureChunk(chunk, 'stdout');
    return (originalStdoutWrite as (...innerArgs: unknown[]) => boolean)(
      chunk,
      ...args,
    );
  }) as unknown as typeof process.stdout.write;

  process.stderr.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    captureChunk(chunk, 'stderr');
    return (originalStderrWrite as (...innerArgs: unknown[]) => boolean)(
      chunk,
      ...args,
    );
  }) as unknown as typeof process.stderr.write;

  historyCapture = {
    startedAt: Date.now(),
    command: `dub ${sanitizedArgs.join(' ')}`,
    output,
    restore: () => {
      if (stdoutBuffer.length > 0) {
        captureLine(stdoutBuffer);
      }
      if (stderrBuffer.length > 0) {
        captureLine(stderrBuffer);
      }
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    },
  };
}

async function finalizeHistoryCapture(
  status: 'success' | 'error',
  errorMessage?: string,
): Promise<void> {
  if (!historyCapture) return;

  const capture = historyCapture;
  historyCapture = null;
  capture.restore();

  const cwd = process.cwd();
  const currentBranch = await getCurrentBranch(cwd).catch(() => undefined);
  const operation = await detectActiveOperation(cwd).catch(() => undefined);

  await appendHistoryEntry(cwd, {
    timestamp: new Date(capture.startedAt).toISOString(),
    command: capture.command,
    status,
    durationMs: Date.now() - capture.startedAt,
    output: capture.output,
    errorMessage,
    invocationMode: invocationMetadata.invocationMode,
    typoGuardTriggered: invocationMetadata.typoGuardTriggered,
    webBrowsingRequested: invocationMetadata.webBrowsingRequested,
    webBrowsingUsed: invocationMetadata.webBrowsingUsed,
    context: {
      currentBranch,
      operation,
    },
  }).catch(() => {
    // Do not block command execution if history append fails.
  });

  historyArgsForCapture = null;
  invocationMetadata = {};
}

function truncateHistoryLine(line: string): string {
  if (line.length <= MAX_HISTORY_OUTPUT_LINE_LENGTH) return line;
  return `${line.slice(0, MAX_HISTORY_OUTPUT_LINE_LENGTH)}...`;
}

function _normalizeHistoryLine(line: string): string {
  const visible = line.split('\r').pop() ?? '';
  return visible.trim().length === 0 ? '' : visible;
}

main();
