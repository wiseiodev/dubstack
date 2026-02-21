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
import chalk from 'chalk';
import { Command } from 'commander';
import { abortCommand } from './commands/abort';
import { branchInfo, formatBranchInfo } from './commands/branch';
import {
  checkout,
  interactiveCheckout,
  resolveCheckoutTrunk,
} from './commands/checkout';
import { children } from './commands/children';
import { continueCommand } from './commands/continue';
import { create } from './commands/create';
import { deleteCommand } from './commands/delete';
import { doctor } from './commands/doctor';
import { init } from './commands/init';
import { log } from './commands/log';
import { mergeCheck } from './commands/merge-check';
import { mergeNext } from './commands/merge-next';
import { bottom, downBySteps, top, upBySteps } from './commands/navigate';
import { parent } from './commands/parent';
import { postMerge } from './commands/post-merge';
import { pr } from './commands/pr';
import { prune } from './commands/prune';
import { ready } from './commands/ready';
import { restack, restackContinue } from './commands/restack';
import type { SubmitPathMode } from './commands/submit';
import { submit } from './commands/submit';
import { sync } from './commands/sync';
import { track } from './commands/track';
import { trunk } from './commands/trunk';
import { undo } from './commands/undo';
import { untrack } from './commands/untrack';
import { DubError } from './lib/errors';
import { getCurrentBranch } from './lib/git';
import {
  appendHistoryEntry,
  normalizeHistoryLine,
  redactSensitiveText,
  sanitizeCommandArgs,
} from './lib/history';
import { detectActiveOperation } from './lib/operation-state';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

const program = new Command();

program
  .name('dub')
  .description('Manage stacked diffs (dependent git branches) with ease')
  .version(version);

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
  .addHelpText(
    'after',
    `
Examples:
  $ dub create feat/api                       Create branch only
  $ dub create feat/api -m "feat: add API"    Create branch + commit staged
  $ dub create feat/api -am "feat: add API"   Stage all + create + commit
  $ dub create --ai                            AI-generate branch + commit from staged`,
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
      },
    ) => {
      const result = await create(branchName, process.cwd(), {
        message: options.message,
        all: options.all,
        update: options.update,
        patch: options.patch,
        ai: options.ai,
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
  .command('log')
  .alias('l')
  .description('Display an ASCII tree of the current stack')
  .option('-s, --stack', 'Only show the current stack')
  .option('-a, --all', 'Show all stacks (default)')
  .option('-r, --reverse', 'Reverse stack/child ordering')
  .addHelpText(
    'after',
    `
Examples:
  $ dub log    Show the branch tree with current branch highlighted`,
  )
  .action(
    async (options: { stack?: boolean; all?: boolean; reverse?: boolean }) => {
      await printLog(process.cwd(), options);
    },
  );

program
  .command('ls')
  .description('Display an ASCII tree of the current stack')
  .option('-s, --stack', 'Only show the current stack')
  .option('-a, --all', 'Show all stacks (default)')
  .option('-r, --reverse', 'Reverse stack/child ordering')
  .action(
    async (options: { stack?: boolean; all?: boolean; reverse?: boolean }) => {
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
      .action(async (branch?: string) => {
        const info = await branchInfo(process.cwd(), branch);
        console.log(formatBranchInfo(info));
      }),
  );

program
  .command('info')
  .argument('[branch]', 'Branch to inspect (defaults to current branch)')
  .description('Show tracked stack info for a branch')
  .action(async (branch?: string) => {
    const info = await branchInfo(process.cwd(), branch);
    console.log(formatBranchInfo(info));
  });

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
  .command('sync')
  .description('Sync tracked branches with remote and reconcile divergence')
  .option('--restack', 'Restack branches after sync')
  .option(
    '-f, --force',
    'Skip prompts for branch reset/reconcile sync decisions',
  )
  .option('-a, --all', 'Sync all tracked stacks across trunks')
  .option('--no-interactive', 'Disable prompts and use deterministic behavior')
  .action(
    async (options: {
      restack?: boolean;
      force?: boolean;
      all?: boolean;
      interactive?: boolean;
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
      console.log(
        chalk.yellow(`⚠ Conflict while restacking '${result.conflictBranch}'`),
      );
      console.log(
        chalk.dim(
          '  Resolve conflicts, stage changes, then run: dub restack --continue',
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
  .action(async () => {
    const result = await continueCommand(process.cwd());
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
        chalk.dim('  Resolve conflicts, stage changes, then run: dub continue'),
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
  .description('Undo the last dub create or dub restack operation')
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
  .option(
    '--path <mode>',
    'Submit scope: current (default) or stack',
    parseSubmitPath,
    'current',
  )
  .option('--fix', 'Apply safe remediation for common submit blockers')
  .addHelpText(
    'after',
    `
Examples:
  $ dub submit           Push and create/update PRs
  $ dub submit --dry-run Preview what would happen
  $ dub submit --path stack --fix Submit full stack with safe auto-remediation`,
  )
  .action(runSubmit);

program
  .command('ss')
  .description('Submit the current stack (alias for submit)')
  .option('--dry-run', 'Print what would happen without executing')
  .option(
    '--path <mode>',
    'Submit scope: current (default) or stack',
    parseSubmitPath,
    'current',
  )
  .option('--fix', 'Apply safe remediation for common submit blockers')
  .action(runSubmit);

program
  .command('merge-check')
  .description('Validate DubStack merge order for a PR')
  .option('--pr <number>', 'PR number to validate', parsePositiveInt)
  .option('--branch <name>', 'Branch name to resolve PR from')
  .action(async (options: { pr?: number; branch?: string }) => {
    const result = await mergeCheck(process.cwd(), {
      pr: options.pr,
      branch: options.branch,
    });
    console.log(chalk.green(`✔ Merge check passed: ${result.reason}`));
  });

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
  .command('ready')
  .description('Run health + submit preflight checks for the current branch')
  .action(async () => {
    const result = await ready(process.cwd());
    console.log(chalk.dim(`Branch: ${result.checkedBranch}`));
    if (result.submitBranches.length > 0) {
      console.log(
        chalk.dim(
          `Submit path (${result.submitPath}): ${result.submitBranches.join(' -> ')} (trunk: ${result.rootBranch})`,
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
  .description('Checkout a branch (interactive picker if no name given)')
  .action(
    async (
      branch: string | undefined,
      options: {
        trunk?: boolean;
        showUntracked?: boolean;
        stack?: boolean;
        all?: boolean;
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
  );

program
  .command('ai')
  .description('Use DubStack AI assistant utilities')
  .addCommand(
    new Command('ask')
      .argument('<prompt...>', 'Prompt text to send to the AI assistant')
      .description('Ask DubStack AI assistant a question')
      .action(async (promptParts: string[]) => {
        const { askAi } = await import('./commands/ai');
        await askAi(promptParts.join(' '), process.cwd());
      }),
  )
  .addCommand(
    new Command('env')
      .description(
        'Write DubStack AI API keys to your shell profile (macOS/Linux)',
      )
      .option('--gemini-key <key>', 'Set DUBSTACK_GEMINI_API_KEY')
      .option('--gateway-key <key>', 'Set DUBSTACK_AI_GATEWAY_API_KEY')
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
          profile?: string;
          shell?: string;
        }) => {
          const { configureAiEnv } = await import('./commands/ai-env');
          const result = await configureAiEnv({
            geminiKey: options.geminiKey,
            gatewayKey: options.gatewayKey,
            profile: options.profile,
            shell: options.shell,
          });

          console.log(chalk.green(`✔ Updated ${result.profilePath}`));
          for (const key of result.updated) {
            console.log(chalk.dim(`  ↳ exported ${key}`));
          }
          console.log(
            chalk.dim(
              `Run: source ${result.profilePath} (or open a new shell)`,
            ),
          );
        },
      ),
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

async function runSubmit(options: {
  dryRun?: boolean;
  path?: SubmitPathMode;
  fix?: boolean;
}) {
  const result = await submit(process.cwd(), options.dryRun ?? false, {
    path: options.path ?? 'current',
    fix: options.fix ?? false,
  });

  if (result.pushed.length > 0 && result.dryRun) {
    console.log(
      chalk.green(
        `✔ Dry-run complete (${result.path} path): would push ${result.pushed.length} branch(es) and check/create ${result.pushed.length} PR(s).`,
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
  }
}

async function printLog(
  cwd: string,
  options: { stack?: boolean; all?: boolean; reverse?: boolean } = {},
) {
  const output = await log(cwd, options);
  const styled = output
    .replace(/\*(.+?) \(Current\)\*/g, chalk.bold.cyan('$1 (Current)'))
    .replace(/⚠ \(missing\)/g, chalk.yellow('⚠ (missing)'));
  console.log(styled);
}

function parseSteps(positional?: string, option?: string): number {
  const raw = option ?? positional;
  if (!raw) return 1;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new DubError('Steps must be a positive integer.');
  }
  return parsed;
}

function parseSubmitPath(value: string): SubmitPathMode {
  if (value === 'current' || value === 'stack') return value;
  throw new DubError("Submit path must be either 'current' or 'stack'.");
}

function parsePositiveInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new DubError('Expected a positive integer.');
  }
  return parsed;
}

function parseMergeMethod(value: string): 'merge' | 'squash' | 'rebase' {
  if (value === 'merge' || value === 'squash' || value === 'rebase') {
    return value;
  }
  throw new DubError('Merge method must be one of: merge, squash, rebase.');
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

program.hook('preAction', () => {
  beginHistoryCapture();
});

program.hook('postAction', async () => {
  await finalizeHistoryCapture('success');
});

async function main() {
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (error instanceof DubError) {
      console.error(chalk.red(`✖ ${error.message}`));
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

  const sanitizedArgs = sanitizeCommandArgs(process.argv.slice(2));
  if (sanitizedArgs.length === 0) return;

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
    context: {
      currentBranch,
      operation,
    },
  }).catch(() => {
    // Do not block command execution if history append fails.
  });
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
