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

import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import chalk, { Chalk } from 'chalk';
import { Command } from 'commander';
import { abortCommand } from './commands/abort';
import { absorb } from './commands/absorb';
import { back, listBackHistory } from './commands/back';
import { branchInfo, branchInfoOutput } from './commands/branch';
import {
  checkout,
  interactiveCheckout,
  resolveCheckoutTrunk,
} from './commands/checkout';
import { children } from './commands/children';
import { completion } from './commands/completion';
import { continueCommand } from './commands/continue';
import { create } from './commands/create';
import { deleteCommand } from './commands/delete';
import { docs } from './commands/docs';
import { doctor } from './commands/doctor';
import { flow } from './commands/flow';
import { fold } from './commands/fold';
import { freeze } from './commands/freeze';
import { init } from './commands/init';
import { type InstallRecipe, install } from './commands/install';
import { log, logJson, styleLogOutput } from './commands/log';
import { man } from './commands/man';
import { mcp } from './commands/mcp';
import { mergeCheck, runMergeCheck } from './commands/merge-check';
import { mergeNext } from './commands/merge-next';
import { migrateStorage } from './commands/migrate';
import { move } from './commands/move';
import { bottom, downBySteps, top, upBySteps } from './commands/navigate';
import { parent } from './commands/parent';
import { pop } from './commands/pop';
import { postMerge } from './commands/post-merge';
import { pr } from './commands/pr';
import { prune } from './commands/prune';
import { type ReadyAiReviewResult, ready } from './commands/ready';
import { redo } from './commands/redo';
import { rename } from './commands/rename';
import { reorder } from './commands/reorder';
import { repo } from './commands/repo';
import { restack, restackContinue } from './commands/restack';
import { revert } from './commands/revert';
import type { SplitMode } from './commands/split';
import { split } from './commands/split';
import { squash } from './commands/squash';
import { stashList, stashPop, stashPush } from './commands/stash';
import { formatStatus, status } from './commands/status';
import type { SubmitPathMode, SubmitScope } from './commands/submit';
import { submit } from './commands/submit';
import { sync } from './commands/sync';
import { track } from './commands/track';
import {
  addTrunk,
  listTrunks,
  removeTrunk,
  setDefaultTrunk,
  trunk,
} from './commands/trunk';
import { clearUndo, listUndo, undo } from './commands/undo';
import { unfreeze } from './commands/unfreeze';
import { unlink } from './commands/unlink';
import { untrack } from './commands/untrack';
import { watch } from './commands/watch';
import { isAiPromptOptionEnabled } from './lib/ai-prompt-decision';
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
import { jsonErrorEnvelope, withSchemaVersion } from './lib/json-schemas';
import { detectActiveOperation } from './lib/operation-state';
import { setVerbose } from './lib/progress';
import {
  resolveRestackConflictDecision,
  restackConflictPrompt,
} from './lib/restack-conflict-prompt';
import { rollbackRestack } from './lib/restack-rollback';
import { parseScope, type ScopeMode } from './lib/scope';
import { getStackOverviewBatch } from './lib/stack-overview';
import { migrateStateRefsIfNeeded } from './lib/state';
import { acquireStateLock, type StateLockHandle } from './lib/state-lock';
import { applyTheme, resolveTheme } from './lib/theme';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

const program = new Command();

/**
 * Set to true when the current action handles its own JSON output. The
 * top-level error handler uses this to emit a `{ schemaVersion, error }`
 * envelope instead of the human red-error formatting, so consumers of
 * `--json` always get parseable output on both success and failure.
 */
let jsonOutputActive = false;

function activateJsonMode(): void {
  jsonOutputActive = true;
}

function emitJsonError(error: DubError): void {
  console.log(
    JSON.stringify(jsonErrorEnvelope(error.message, error.recovery), null, 2),
  );
}

/**
 * Emits the dry-run plan for a mutating command. Used by every command that
 * supports `--dry-run --json` to serialise the plan with the standard schema
 * envelope.
 */
function emitDryRunPlan(plan: object): void {
  // JSON mode should already be active (see `maybeActivateDryRunJsonMode`)
  // so any pre-emit error has already been envelope-formatted. We still call
  // it here for safety in case a caller bypassed the early-activation hook.
  activateJsonMode();
  console.log(JSON.stringify(withSchemaVersion(plan), null, 2));
}

/**
 * Switch the top-level error handler to JSON-envelope output whenever an
 * action sees `--dry-run --json`. Called at the head of each mutating
 * command's action so a `DubError` thrown during validation (before
 * `emitDryRunPlan` would otherwise fire) still emits the standard
 * `jsonErrorEnvelope` shape for scripted callers, instead of the human
 * red-error formatting that breaks JSON parsers.
 */
function maybeActivateDryRunJsonMode(options: {
  dryRun?: boolean;
  json?: boolean;
}): void {
  if (options.dryRun && options.json) {
    activateJsonMode();
  }
}

async function canShowAiPrompt(cwd: string): Promise<boolean> {
  try {
    return await isAiPromptOptionEnabled(cwd);
  } catch {
    return false;
  }
}

async function showInfo(
  branch: string | undefined,
  options: { diff?: boolean; json?: boolean },
): Promise<void> {
  if (options.json) {
    activateJsonMode();
    const info = await branchInfo(process.cwd(), branch);
    console.log(JSON.stringify(withSchemaVersion(info), null, 2));
    return;
  }
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
  .option(
    '--no-color',
    'Disable ANSI colors globally (overrides the configured theme)',
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
  .option(
    '--restore-from-refs',
    'Rebuild .git/dubstack/state.json from refs/dubstack/*',
  )
  .addHelpText(
    'after',
    `
Examples:
  $ dub init                       Initialize DubStack, creating .git/dubstack/ and updating .gitignore
  $ dub init --restore-from-refs   Restore state.json from refs/dubstack/*

See also:
  dub install, dub config, dub doctor`,
  )
  .action(async (options: { restoreFromRefs?: boolean }) => {
    const result = await init(process.cwd(), {
      restoreFromRefs: options.restoreFromRefs,
    });
    if (result.status === 'created') {
      console.log(chalk.green('✔ DubStack initialized'));
    } else if (result.status === 'restored') {
      console.log(chalk.green('✔ DubStack state restored from refs'));
    } else {
      console.log(chalk.yellow('⚠ DubStack already initialized'));
    }
  });

program
  .command('install')
  .argument('<recipe>', 'Recipe to install (e.g. retarget-action)')
  .option('--dry-run', 'Print the planned write without touching disk')
  .option(
    '--force',
    'Overwrite an existing file with different content without confirming',
  )
  .description(
    'Install a Dubstack recipe (workflow templates, etc.) into the current repo',
  )
  .addHelpText(
    'after',
    `
Recipes:
  retarget-action    GitHub Action that retargets dependent PRs when a stack PR merges

Examples:
  $ dub install retarget-action             Write .github/workflows/dubstack-retarget.yml
  $ dub install retarget-action --dry-run   Preview the planned write
  $ dub install retarget-action --force     Overwrite an existing file without confirming

See also:
  dub docs, dub init`,
  )
  .action(
    async (recipe: string, options: { dryRun?: boolean; force?: boolean }) => {
      const result = await install(process.cwd(), recipe as InstallRecipe, {
        dryRun: options.dryRun,
        force: options.force,
        confirm: async (message) => {
          // Non-interactive shells (piped stdin, CI scripts) would hang
          // forever on rl.question. Treat as "no" and let the caller surface
          // a 'cancelled' result; the user can pass --force for scripted
          // overwrites.
          if (!process.stdin.isTTY) {
            console.log(
              chalk.yellow(
                '⚠ Refusing to prompt for confirmation in a non-interactive shell. Re-run with --force to overwrite, or --dry-run to preview.',
              ),
            );
            return false;
          }
          const readline = await import('node:readline/promises');
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });
          try {
            const answer = await rl.question(`${message} [y/N] `);
            const normalized = answer.trim().toLowerCase();
            return normalized === 'y' || normalized === 'yes';
          } finally {
            rl.close();
          }
        },
      });

      switch (result.status) {
        case 'installed':
          console.log(chalk.green(`✔ Installed at ${result.path}`));
          console.log(
            chalk.dim(
              '  Commit and push the workflow file. The Action runs on the next merge.',
            ),
          );
          break;
        case 'overwritten':
          console.log(chalk.green(`✔ Overwrote ${result.path}`));
          console.log(
            chalk.dim('  Commit and push to pick up the new content.'),
          );
          break;
        case 'already-installed':
          console.log(
            chalk.yellow(`⚠ Already installed at ${result.path} (no change)`),
          );
          break;
        case 'preview':
          console.log(chalk.dim(`# Would write to ${result.path}:`));
          console.log(result.content);
          break;
        case 'cancelled':
          console.log(chalk.yellow('⚠ Cancelled. No changes written.'));
          break;
      }
    },
  );

program
  .command('completion')
  .argument('<shell>', 'Shell to generate completions for: bash, zsh, or fish')
  .description('Print a shell completion script to stdout')
  .addHelpText(
    'after',
    `
Examples:
  $ dub completion bash >> ~/.bashrc
  $ dub completion zsh > "\${fpath[1]}/_dub"
  $ dub completion fish > ~/.config/fish/completions/dub.fish

See also:
  dub man, dub docs`,
  )
  .action((shell: string) => {
    process.stdout.write(completion(program, shell));
  });

program
  .command('man')
  .description('Print a roff-formatted man page for `dub` to stdout')
  .addHelpText(
    'after',
    `
Examples:
  $ dub man > ~/.local/share/man/man1/dub.1
  $ mandb --user-db    # then 'man dub' renders the page

See also:
  dub completion, dub docs, dub help`,
  )
  .action(() => {
    process.stdout.write(man(program, { version }));
  });

program
  .command('docs')
  .description('Open the DubStack docs website in your browser')
  .addHelpText(
    'after',
    `
Examples:
  $ dub docs    Open the DubStack docs website

See also:
  dub repo, dub help`,
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
  $ dub repo    Open the current repository GitHub page

See also:
  dub pr, dub docs`,
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
  .option(
    '--dry-run',
    'Print the planned create without mutating refs or state',
  )
  .option('--json', 'Pair with --dry-run to emit the plan as JSON')
  .addHelpText(
    'after',
    `
Examples:
  $ dub create feat/api                       Create branch only
  $ dub create feat/api -m "feat: add API"    Create branch + commit staged
  $ dub create feat/api -am "feat: add API"   Stage all + create + commit
  $ dub create --ai                            AI-generate branch + commit from staged
  $ dub create --no-ai feat/api                Override repo AI defaults for one create
  $ dub create feat/api --dry-run              Preview the plan without mutating

See also:
  dub modify, dub flow, dub track, dub log`,
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
        dryRun?: boolean;
        json?: boolean;
      },
    ) => {
      const result = await create(branchName, process.cwd(), {
        message: options.message,
        all: options.all,
        update: options.update,
        patch: options.patch,
        ai: options.ai,
        noAi: options.noAi,
        dryRun: options.dryRun,
      });
      if (result.dryRun) {
        if (options.json) {
          emitDryRunPlan(result);
          return;
        }
        console.log(
          chalk.green(
            `✔ Dry-run: would create '${result.branch}' on '${result.parent}'${result.committed ? ` • ${result.committed}` : ''}`,
          ),
        );
        return;
      }
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
  $ dub flow --dry-run    Preview generated branch, commit, and PR text only

See also:
  dub create, dub submit, dub ai setup`,
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
  $ dub log                   Show the branch tree with current branch highlighted
  $ dub log --stack           Only show the current stack
  $ dub log --json            Emit machine-readable JSON
  $ dub log --refresh         Bust the 30-second PR/CI overview cache

See also:
  dub ls, dub status, dub info, dub watch`,
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
  .description('Display an ASCII tree of the current stack (alias of log)')
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
  $ dub ls                      Show every tracked stack
  $ dub ls --stack              Show only the current stack
  $ dub ls --json               Emit machine-readable JSON

See also:
  dub log, dub status, dub info`,
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
  .command('back')
  .argument('[steps]', 'Number of checkout-history entries to go back')
  .option('-l, --list', 'List recent checkout history without switching')
  .description('Return to a previously checked-out branch')
  .addHelpText(
    'after',
    `
Examples:
  $ dub back              Switch back to the previous branch
  $ dub back 3            Jump 3 entries back in the checkout history
  $ dub back --list       Show recent checkout history without switching

See also:
  dub checkout, dub co, dub up, dub down`,
  )
  .action(async (stepsArg: string | undefined, options: { list?: boolean }) => {
    if (options.list) {
      const entries = await listBackHistory(process.cwd());
      if (entries.length === 0) {
        console.log(chalk.yellow('⚠ No checkout history found'));
        return;
      }
      for (const [index, entry] of entries.entries()) {
        console.log(
          `${index + 1}. ${entry.branch} ${chalk.dim(`(${entry.via}, ${entry.at})`)}`,
        );
      }
      return;
    }

    const result = await back(process.cwd(), parseBackSteps(stepsArg));
    for (const entry of result.skipped) {
      console.log(
        chalk.yellow(
          `⚠ Skipped '${entry.branch}' from checkout history because it no longer exists locally.`,
        ),
      );
    }
    console.log(chalk.green(`✔ Switched back to '${result.branch}'`));
  });

program
  .command('up')
  .argument('[steps]', 'Number of levels to traverse upstack')
  .option('-n, --steps <count>', 'Number of levels to traverse upstack')
  .description('Checkout the child branch directly above the current branch')
  .addHelpText(
    'after',
    `
Examples:
  $ dub up           Step one branch upstack (toward descendants)
  $ dub up 2         Step two branches upstack
  $ dub up --steps 3 Step three branches upstack

See also:
  dub down, dub top, dub bottom, dub co`,
  )
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
  .addHelpText(
    'after',
    `
Examples:
  $ dub down            Step one branch downstack (toward trunk)
  $ dub down 2          Step two branches downstack
  $ dub down --steps 3  Step three branches downstack

See also:
  dub up, dub top, dub bottom, dub co`,
  )
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
  .addHelpText(
    'after',
    `
Examples:
  $ dub top    Jump to the highest tip in the current stack path

See also:
  dub bottom, dub up, dub down`,
  )
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
  .addHelpText(
    'after',
    `
Examples:
  $ dub bottom    Jump to the branch sitting directly on trunk

See also:
  dub top, dub up, dub down`,
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
  .addHelpText(
    'after',
    `
Examples:
  $ dub branch info                  Show stack info for the current branch
  $ dub branch info feat/auth-login  Show stack info for a specific branch

See also:
  dub info, dub log, dub parent, dub children`,
  )
  .addCommand(
    new Command('info')
      .description('Show tracked stack info for the current branch')
      .argument('[branch]', 'Branch to inspect (defaults to current branch)')
      .option('-d, --diff', 'Show the parent-relative git diff for the branch')
      .option('--json', 'Output branch info as JSON')
      .addHelpText(
        'after',
        `
Examples:
  $ dub branch info                  Show stack info for the current branch
  $ dub branch info feat/auth-login  Show stack info for a specific branch
  $ dub branch info --diff           Include parent-relative diff inline
  $ dub branch info --json           Emit machine-readable JSON

See also:
  dub info, dub log, dub parent, dub children`,
      )
      .action(showInfo),
  );

program
  .command('info')
  .argument('[branch]', 'Branch to inspect (defaults to current branch)')
  .option('-d, --diff', 'Show the parent-relative git diff for the branch')
  .option('--json', 'Output branch info as JSON')
  .description('Show tracked stack info for a branch')
  .addHelpText(
    'after',
    `
Examples:
  $ dub info                       Inspect the current branch
  $ dub info feat/auth-login       Inspect a specific tracked branch
  $ dub info --diff                Show parent-relative diff inline
  $ dub info --json                Emit machine-readable JSON

See also:
  dub status, dub log, dub parent, dub children`,
  )
  .action(showInfo);

program
  .command('track')
  .argument('[branch]', 'Branch to track (defaults to current branch)')
  .option('-p, --parent <branch>', 'Parent branch for tracking')
  .option(
    '--no-interactive',
    'Disable parent prompt and require deterministic behavior',
  )
  .option('--dry-run', 'Print the planned track without mutating state')
  .option('--json', 'Pair with --dry-run to emit the plan as JSON')
  .description('Track a branch or update its parent relationship')
  .addHelpText(
    'after',
    `
Examples:
  $ dub track                                  Adopt the current branch (DubStack picks the parent)
  $ dub track feat/a --parent main             Adopt feat/a with main as the explicit parent
  $ dub track feat/a --parent main --dry-run   Preview the plan without mutating

See also:
  dub untrack, dub create, dub log, dub doctor`,
  )
  .action(
    async (
      branch: string | undefined,
      options: {
        parent?: string;
        interactive?: boolean;
        dryRun?: boolean;
        json?: boolean;
      },
    ) => {
      const result = await track(process.cwd(), branch, {
        parent: options.parent,
        interactive: options.interactive,
        dryRun: options.dryRun,
      });
      if (result.dryRun) {
        if (options.json) {
          emitDryRunPlan(result);
          return;
        }
        console.log(
          chalk.green(
            `✔ Dry-run: would ${result.status} '${result.branch}' on '${result.parent}'`,
          ),
        );
        return;
      }
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
  .option('--dry-run', 'Print the planned untrack without mutating state')
  .option('--json', 'Pair with --dry-run to emit the plan as JSON')
  .description(
    'Remove branch metadata from DubStack without deleting git branches',
  )
  .addHelpText(
    'after',
    `
Examples:
  $ dub untrack                       Drop tracking metadata for the current branch
  $ dub untrack feat/a --downstack    Untrack feat/a and its ancestors toward trunk
  $ dub untrack feat/a --dry-run      Preview the plan without mutating

See also:
  dub track, dub delete, dub prune`,
  )
  .action(
    async (
      branch: string | undefined,
      options: {
        downstack?: boolean;
        interactive?: boolean;
        dryRun?: boolean;
        json?: boolean;
      },
    ) => {
      const result = await untrack(process.cwd(), branch, {
        downstack: options.downstack,
        interactive: options.interactive,
        dryRun: options.dryRun,
      });
      if (result.dryRun) {
        if (options.json) {
          emitDryRunPlan(result);
          return;
        }
        console.log(
          chalk.green(
            `✔ Dry-run: would untrack ${result.removed.length} branch(es): ${result.removed.join(', ')}`,
          ),
        );
        return;
      }
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
  .option(
    '--dry-run',
    'Print the planned delete without mutating refs or state',
  )
  .option('--json', 'Pair with --dry-run to emit the plan as JSON')
  .description('Delete local branches and update DubStack metadata')
  .addHelpText(
    'after',
    `
Examples:
  $ dub delete feat/a                       Delete feat/a (with confirmation)
  $ dub delete feat/a --upstack -f -q       Delete feat/a + descendants, force, quiet
  $ dub delete feat/a --dry-run             Preview the plan without mutating

See also:
  dub untrack, dub prune, dub fold`,
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
        dryRun?: boolean;
        json?: boolean;
      },
    ) => {
      const result = await deleteCommand(process.cwd(), branch, {
        upstack: options.upstack,
        downstack: options.downstack,
        force: options.force,
        quiet: options.quiet,
        interactive: options.interactive,
        dryRun: options.dryRun,
      });
      if (result.dryRun) {
        if (options.json) {
          emitDryRunPlan(result);
          return;
        }
        console.log(
          chalk.green(
            `✔ Dry-run: would delete ${result.deleted.length} branch(es): ${result.deleted.join(', ')}`,
          ),
        );
        return;
      }
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
  .option('--dry-run', 'Print the planned fold without mutating refs or state')
  .option('--json', 'Pair with --dry-run to emit the plan as JSON')
  .addHelpText(
    'after',
    `
Examples:
  $ dub fold                Fold current branch into parent (keeps commits)
  $ dub fold --squash       Collapse current branch into a single commit on parent
  $ dub fold --force        Skip the confirmation prompt
  $ dub fold --dry-run      Preview the plan without mutating

See also:
  dub squash, dub delete, dub move`,
  )
  .action(
    async (options: {
      force?: boolean;
      squash?: boolean;
      keepCommits?: boolean;
      interactive?: boolean;
      dryRun?: boolean;
      json?: boolean;
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
        dryRun: options.dryRun,
      });
      if (result.dryRun) {
        if (options.json) {
          emitDryRunPlan(result);
          return;
        }
        console.log(
          chalk.green(
            `✔ Dry-run: would fold '${result.branch}' (${result.foldedCommits} commit(s)) into '${result.parent}'`,
          ),
        );
        return;
      }
      if (result.cancelled) {
        console.log(chalk.yellow('⚠ Fold cancelled.'));
        return;
      }
      const summary = options.squash
        ? `squashed ${result.foldedCommits} commit(s)`
        : `kept ${result.foldedCommits} commit(s)`;
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
  .option('--dry-run', 'Print the planned move without mutating refs or state')
  .option('--json', 'Pair with --dry-run to emit the plan as JSON')
  .description(
    'Reorder a tracked branch within its stack (insert before or after another branch)',
  )
  .addHelpText(
    'after',
    `
Examples:
  $ dub move feat/inserted --before feat/auth-login    Insert before <target>
  $ dub move feat/inserted --after feat/auth-base      Insert after <target>
  $ dub move feat/x --after feat/y --dry-run           Preview the plan without mutating

See also:
  dub reorder, dub unlink, dub restack`,
  )
  .action(
    async (
      branch: string,
      options: {
        before?: string;
        after?: string;
        dryRun?: boolean;
        json?: boolean;
      },
    ) => {
      const result = await move(process.cwd(), branch, {
        before: options.before,
        after: options.after,
        dryRun: options.dryRun,
      });
      if (result.dryRun) {
        if (options.json) {
          emitDryRunPlan(result);
          return;
        }
        console.log(
          chalk.green(
            `✔ Dry-run: would move '${result.branch}' ${result.position} '${result.target}' (new parent: '${result.newParent}')`,
          ),
        );
        if (result.retargetCandidates && result.retargetCandidates.length > 0) {
          console.log(
            chalk.dim(
              `  ↳ retarget candidates (PRs with pr_number; real run verifies state): ${result.retargetCandidates.join(', ')}`,
            ),
          );
        }
        return;
      }
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
  .command('absorb')
  .description(
    'Distribute fixup commits to their target commits (git-native autosquash, AI ambiguity resolver, or cross-branch mover)',
  )
  .option(
    '--ai',
    'AI-pick targets for ambiguous WIP commits on the current branch',
  )
  .option(
    '--stack',
    'Move fixup commits whose target lives on a different branch in the stack',
  )
  .option('--dry-run', 'Print what would be absorbed without mutating')
  .option('--json', 'Pair with --dry-run to emit the plan as JSON')
  .addHelpText(
    'after',
    `
Examples:
  $ dub absorb                Autosquash literal 'fixup!' / 'squash!' commits on the current branch
  $ dub absorb --ai           Use the configured AI provider to pick targets for ambiguous WIP commits
  $ dub absorb --stack        Move fixup commits across branches in the stack, then restack
  $ dub absorb --dry-run      Print the plan without mutating

See also:
  dub modify, dub squash, dub restack`,
  )
  .action(
    async (options: {
      ai?: boolean;
      stack?: boolean;
      dryRun?: boolean;
      json?: boolean;
    }) => {
      const result = await absorb(process.cwd(), options);
      if (result.dryRun && options.json) {
        emitDryRunPlan(result);
        return;
      }
      if (result.conflict) {
        console.log(
          chalk.yellow(
            `⚠ Conflict during absorb on '${result.branch}'. Resolve and run 'dub continue' (or 'dub continue --ai').`,
          ),
        );
        return;
      }
      if (result.absorbed === 0 && result.skipped === 0) {
        console.log(
          chalk.dim(
            result.mode === 'stack'
              ? 'Nothing to absorb: no cross-branch fixup commits found.'
              : 'Nothing to absorb: no fixup commits found.',
          ),
        );
        return;
      }
      const verb = options.dryRun ? 'Would absorb' : '✔ Absorbed';
      console.log(chalk.green(`${verb} ${result.absorbed} commit(s)`));
      if (result.skipped > 0) {
        console.log(
          chalk.dim(
            `  ↳ skipped: ${result.skipped} ambiguous commit(s) the AI could not assign`,
          ),
        );
      }
      if (result.movedTo.length > 0) {
        console.log(chalk.dim(`  ↳ moved onto: ${result.movedTo.join(', ')}`));
      }
      if (result.restacked.length > 0) {
        console.log(chalk.dim(`  ↳ restacked: ${result.restacked.join(', ')}`));
      }
    },
  );

program
  .command('unlink')
  .argument('<branch>', 'Branch to detach from its parent')
  .option(
    '--no-retarget',
    'Leave PR base unchanged (warn that the PR will be out of sync)',
  )
  .option(
    '--keep-children',
    'Move descendants with <branch> into the new stack (default)',
  )
  .option(
    '--orphan-children',
    'Re-parent direct children onto the original parent instead of moving them',
  )
  .option(
    '--dry-run',
    'Print the planned unlink without mutating refs or state',
  )
  .option('--json', 'Pair with --dry-run to emit the plan as JSON')
  .description(
    'Detach a tracked branch from its parent, splitting it into its own stack',
  )
  .addHelpText(
    'after',
    `
Examples:
  $ dub unlink feat/auth-login                Promote feat/auth-login to a new stack root
  $ dub unlink feat/auth-login --orphan-children  Leave descendants on the original parent
  $ dub unlink feat/auth-login --no-retarget  Skip PR retarget (warns about drift)
  $ dub unlink feat/auth-login --dry-run      Preview the plan without mutating

See also:
  dub move, dub track, dub untrack`,
  )
  .action(
    async (
      branch: string,
      options: {
        retarget?: boolean;
        keepChildren?: boolean;
        orphanChildren?: boolean;
        dryRun?: boolean;
        json?: boolean;
      },
    ) => {
      if (options.keepChildren && options.orphanChildren) {
        throw new DubError(
          "Pass only one of '--keep-children' or '--orphan-children'.",
          [
            "Pass '--keep-children' (default) to move descendants with <branch>.",
            "Pass '--orphan-children' to leave descendants on the original parent.",
          ],
        );
      }
      const result = await unlink(process.cwd(), branch, {
        noRetarget: options.retarget === false,
        orphanChildren: options.orphanChildren ?? false,
        dryRun: options.dryRun,
      });
      if (result.dryRun) {
        if (options.json) {
          emitDryRunPlan(result);
          return;
        }
        console.log(
          chalk.green(
            `✔ Dry-run: would unlink '${result.branch}' from '${result.previousParent}'`,
          ),
        );
        return;
      }
      console.log(
        chalk.green(
          `✔ Unlinked '${result.branch}' from '${result.previousParent}'`,
        ),
      );
      if (result.movedDescendants.length > 0) {
        console.log(
          chalk.dim(
            `  ↳ Moved ${result.movedDescendants.length} descendant(s) into new stack: ${result.movedDescendants.join(', ')}`,
          ),
        );
      }
      if (result.orphanedChildren.length > 0) {
        console.log(
          chalk.dim(
            `  ↳ Re-parented ${result.orphanedChildren.length} child(ren) onto '${result.previousParent}': ${result.orphanedChildren.join(', ')}`,
          ),
        );
      }
      if (result.retargeted && result.prNumber != null) {
        console.log(
          chalk.dim(
            `  ↳ Retargeted PR #${result.prNumber} → '${result.trunk}'`,
          ),
        );
      } else if (result.retargetSkipped && result.prNumber != null) {
        console.log(
          chalk.yellow(
            `⚠ PR #${result.prNumber} not retargeted (--no-retarget). If its base is no longer correct after the split, retarget manually.`,
          ),
        );
        console.log(
          chalk.dim(
            `  Run 'gh pr edit ${result.prNumber} --base ${result.trunk}' to retarget to '${result.trunk}'.`,
          ),
        );
      }
    },
  );

program
  .command('parent')
  .argument('[branch]', 'Branch to inspect (defaults to current branch)')
  .option('--json', 'Output parent info as JSON')
  .description('Show the direct parent branch')
  .addHelpText(
    'after',
    `
Examples:
  $ dub parent                   Print the parent of the current branch
  $ dub parent feat/auth-login   Print the parent of a specific branch
  $ dub parent --json            Emit JSON for shell scripts

See also:
  dub children, dub info, dub log`,
  )
  .action(async (branch: string | undefined, options: { json?: boolean }) => {
    if (options.json) activateJsonMode();
    const result = await parent(process.cwd(), branch);
    if (options.json) {
      console.log(JSON.stringify(withSchemaVersion(result), null, 2));
      return;
    }
    console.log(result.parent);
  });

program
  .command('children')
  .argument('[branch]', 'Branch to inspect (defaults to current branch)')
  .option('--json', 'Output children info as JSON')
  .description('Show direct child branches')
  .addHelpText(
    'after',
    `
Examples:
  $ dub children                   Print children of the current branch
  $ dub children feat/auth-base    Print children of a specific branch
  $ dub children --json            Emit JSON for shell scripts

See also:
  dub parent, dub info, dub log`,
  )
  .action(async (branch: string | undefined, options: { json?: boolean }) => {
    if (options.json) activateJsonMode();
    const result = await children(process.cwd(), branch);
    if (options.json) {
      console.log(JSON.stringify(withSchemaVersion(result), null, 2));
      return;
    }
    if (result.children.length === 0) {
      console.log('(none)');
      return;
    }
    for (const child of result.children) {
      console.log(child);
    }
  });

const trunkCommand = program
  .command('trunk')
  .argument('[branch]', 'Branch to inspect (defaults to current branch)')
  .option('--json', 'Output trunk info as JSON')
  .description('Show or manage configured trunk branches')
  .addHelpText(
    'after',
    `
Examples:
  $ dub trunk                         Show current stack trunk
  $ dub trunk list                    List configured trunks
  $ dub trunk add develop             Register another trunk
  $ dub trunk set-default develop     Use develop for new untracked stacks`,
  )
  .action(async (branch: string | undefined, options: { json?: boolean }) => {
    if (options.json) activateJsonMode();
    const result = await trunk(process.cwd(), branch);
    if (options.json) {
      console.log(JSON.stringify(withSchemaVersion(result), null, 2));
      return;
    }
    console.log(result.trunk);
  });

trunkCommand
  .command('list')
  .description('List configured trunk branches')
  .addHelpText(
    'after',
    `
Examples:
  $ dub trunk list    Print every configured trunk with the default marked

See also:
  dub trunk add, dub trunk set-default`,
  )
  .action(async () => {
    const result = await listTrunks(process.cwd());
    for (const entry of result.trunks) {
      console.log(entry.default ? `${entry.name} (default)` : entry.name);
    }
  });

trunkCommand
  .command('add')
  .argument('<name>', 'Trunk branch name to register')
  .description('Register a trunk branch')
  .addHelpText(
    'after',
    `
Examples:
  $ dub trunk add main          Register 'main' as a trunk
  $ dub trunk add release/24.x  Register a release-line trunk

See also:
  dub trunk list, dub trunk set-default, dub trunk remove`,
  )
  .action(async (name: string) => {
    const result = await addTrunk(process.cwd(), name);
    if (result.status === 'already-exists') {
      console.log(
        chalk.yellow(`⚠ Trunk '${result.trunk}' is already configured`),
      );
    } else {
      console.log(chalk.green(`✔ Added trunk '${result.trunk}'`));
    }
  });

trunkCommand
  .command('remove')
  .argument('<name>', 'Trunk branch name to remove')
  .description('Remove a configured trunk branch')
  .addHelpText(
    'after',
    `
Examples:
  $ dub trunk remove release/24.x   Unregister a configured trunk

See also:
  dub trunk add, dub trunk list`,
  )
  .action(async (name: string) => {
    const result = await removeTrunk(process.cwd(), name);
    console.log(chalk.green(`✔ Removed trunk '${result.trunk}'`));
  });

trunkCommand
  .command('set-default')
  .argument('<name>', 'Configured trunk to use by default')
  .description('Set the default trunk for new stacks')
  .addHelpText(
    'after',
    `
Examples:
  $ dub trunk set-default main           Use 'main' for new untracked stacks
  $ dub trunk set-default release/24.x   Switch the default to a release line

See also:
  dub trunk list, dub trunk add`,
  )
  .action(async (name: string) => {
    const result = await setDefaultTrunk(process.cwd(), name);
    console.log(chalk.green(`✔ Default trunk is now '${result.trunk}'`));
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
  $ dub watch --ui                Render live status pane

See also:
  dub status, dub log, dub sync`,
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
  .option(
    '--dry-run',
    'Print the planned sync scope without fetching or mutating',
  )
  .option('--json', 'Pair with --dry-run to emit the plan as JSON')
  .addHelpText(
    'after',
    `
Examples:
  $ dub sync                Sync the current stack with origin and restack
  $ dub sync --all          Sync every tracked stack across trunks
  $ dub sync --no-restack   Sync without restacking (manual fix-up later)
  $ dub sync --fresh        Force-fetch each branch even if cached
  $ dub sync -f             Skip prompts on reset/reconcile decisions
  $ dub sync --dry-run      Preview the planned scope without fetching

See also:
  dub restack, dub post-merge, dub merge-next`,
  )
  .action(
    async (options: {
      restack?: boolean;
      force?: boolean;
      all?: boolean;
      interactive?: boolean;
      fresh?: boolean;
      dryRun?: boolean;
      json?: boolean;
    }) => {
      const result = await sync(process.cwd(), {
        restack: options.restack,
        force: options.force,
        all: options.all,
        interactive: options.interactive,
        fresh: options.fresh,
        dryRun: options.dryRun,
      });
      if (result.dryRun) {
        if (options.json) {
          emitDryRunPlan(result);
          return;
        }
        const scope = result.plannedScope;
        console.log(
          chalk.green(
            `✔ Dry-run: would sync ${scope?.roots.length ?? 0} trunk(s) and ${scope?.branches.length ?? 0} branch(es)`,
          ),
        );
      }
    },
  );

program
  .command('restack')
  .description('Rebase all branches in the stack onto their updated parents')
  .option('--continue', 'Continue restacking after resolving conflicts')
  .option(
    '--dry-run',
    'Print the planned restack without rebasing or mutating state',
  )
  .option('--json', 'Pair with --dry-run to emit the plan as JSON')
  .addHelpText(
    'after',
    `
Examples:
  $ dub restack              Rebase the current stack onto its updated parents
  $ dub restack --continue   Continue after resolving conflicts
  $ dub restack --dry-run    Preview which branches would be rebased

See also:
  dub continue, dub abort, dub sync, dub post-merge`,
  )
  .action(
    async (options: {
      continue?: boolean;
      dryRun?: boolean;
      json?: boolean;
    }) => {
      if (options.continue && options.dryRun) {
        // `--continue` resumes an in-flight rebase mid-conflict — there is
        // no non-mutating preview for it. Refuse the combination instead of
        // silently ignoring one flag.
        throw new DubError(
          "'--continue' cannot be combined with '--dry-run'.",
          [
            "Run 'dub restack --continue' to resume the in-flight restack after resolving conflicts.",
            "Run 'dub restack --dry-run' to preview the planned rebases (no in-flight restack required).",
          ],
        );
      }
      const result = options.continue
        ? await restackContinue(process.cwd())
        : await restack(process.cwd(), { dryRun: options.dryRun });

      if (result.dryRun) {
        if (options.json) {
          emitDryRunPlan(result);
          return;
        }
        const planned = result.plannedRebases ?? [];
        const skipped = result.plannedSkips ?? [];
        console.log(
          chalk.green(
            `✔ Dry-run: would rebase ${planned.length} branch(es); skip ${skipped.length}`,
          ),
        );
        for (const branch of planned) {
          console.log(chalk.dim(`  ↳ rebase: ${branch}`));
        }
        return;
      }

      if (result.status === 'up-to-date') {
        console.log(chalk.green('✔ Stack is already up to date'));
      } else if (result.status === 'conflict') {
        const interactive = Boolean(
          process.stdout.isTTY && process.stdin.isTTY,
        );
        const conflictBranch = result.conflictBranch ?? 'unknown';
        const showAiOption = interactive
          ? await canShowAiPrompt(process.cwd())
          : false;
        const decision = await resolveRestackConflictDecision({
          branch: conflictBranch,
          interactive,
          showAiOption,
          promptChoice: (branchName) =>
            restackConflictPrompt({ branch: branchName, showAiOption }),
        });
        if (decision === 'ai') {
          await continueCommand(process.cwd(), { ai: true });
          return;
        }
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
    },
  );

program
  .command('continue')
  .description('Continue the active restack or git rebase operation')
  .option('--ai', 'Use AI to resolve conflicts before continuing')
  .option('--adjudicate', 'Resolve conflicts with two configured AI providers')
  .option(
    '--no-adjudicate',
    'Use one configured AI provider for conflict resolution',
  )
  .addHelpText(
    'after',
    `
Examples:
  $ dub continue                Resume restack/rebase after manual conflict resolution
  $ dub continue --ai           Ask the AI to propose resolutions, then continue
  $ dub continue --adjudicate   Use two AI providers and pick the better fix

See also:
  dub restack, dub abort, dub ai resolve`,
  )
  .action(async (options: { ai?: boolean; adjudicate?: boolean }) => {
    const result = await continueCommand(process.cwd(), {
      ai: options.ai,
      adjudicate: options.adjudicate,
    });
    if (result.continued === 'ai-resolve') {
      return;
    }
    if (result.continued === 'rebase') {
      console.log(chalk.green('✔ Continued git rebase.'));
      return;
    }
    if (result.continued === 'absorb') {
      console.log(chalk.green('✔ Continued absorb.'));
      if (result.absorbResult && result.absorbResult.restacked.length > 0) {
        console.log(
          chalk.dim(
            `  ↳ restacked: ${result.absorbResult.restacked.join(', ')}`,
          ),
        );
      }
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
  .addHelpText(
    'after',
    `
Examples:
  $ dub abort    Roll back the in-progress restack/rebase and restore branches

See also:
  dub continue, dub restack, dub undo`,
  )
  .action(async () => {
    const result = await abortCommand(process.cwd());
    if (result.aborted === 'restack') {
      console.log(chalk.green('✔ Aborted restack and cleared progress.'));
      return;
    }
    if (result.aborted === 'absorb') {
      console.log(chalk.green('✔ Aborted absorb and cleared progress.'));
      return;
    }
    console.log(chalk.green('✔ Aborted git rebase.'));
  });

program
  .command('undo')
  .description(
    'Undo recent dub operations from the 20-entry ring buffer (create, restack, rename, move, pop, reorder, freeze, unfreeze, absorb, unlink, track, untrack, delete, modify, sync, split, submit)',
  )
  .option(
    '-n, --steps <count>',
    'Number of recent operations to undo in sequence (default 1)',
    parsePositiveInt,
  )
  .option('--list', 'List the undo ring buffer (newest first) without undoing')
  .option('--clear', 'Wipe both the undo and redo ring buffers')
  .addHelpText(
    'after',
    `
Examples:
  $ dub undo                  Roll back the last dub operation
  $ dub undo --steps 3        Roll back the last three operations
  $ dub undo --list           Show recent undoable operations with timestamps
  $ dub undo --clear          Wipe both the undo and redo logs

See also:
  dub redo, dub abort, dub history`,
  )
  .action(
    async (options: { steps?: number; list?: boolean; clear?: boolean }) => {
      if (options.list) {
        const entries = await listUndo(process.cwd());
        if (entries.length === 0) {
          console.log(chalk.dim('(undo log is empty)'));
          return;
        }
        // Newest first for human consumption.
        for (let i = entries.length - 1; i >= 0; i--) {
          const entry = entries[i];
          const index = entries.length - i;
          const stamp = entry.timestamp;
          const branchInfo = entry.previousBranch
            ? ` on '${entry.previousBranch}'`
            : '';
          const summary = entry.summary ?? '';
          const tail = summary ? ` — ${summary}` : '';
          console.log(
            `${index}. ${chalk.bold(entry.operation)}${branchInfo} ${chalk.dim(`(${stamp})`)}${tail}`,
          );
        }
        return;
      }
      if (options.clear) {
        await clearUndo(process.cwd());
        console.log(chalk.green('✔ Cleared undo and redo logs.'));
        return;
      }
      const result = await undo(process.cwd(), { steps: options.steps });
      console.log(chalk.green(`✔ Undid '${result.undone}': ${result.details}`));
      for (const warning of result.warnings ?? []) {
        console.log(chalk.yellow(`⚠ ${warning}`));
      }
    },
  );

program
  .command('redo')
  .description(
    'Redo the most recently undone operation by replaying its captured post-state',
  )
  .addHelpText(
    'after',
    `
Examples:
  $ dub redo    Re-apply the most recently undone operation

See also:
  dub undo, dub history`,
  )
  .action(async () => {
    const result = await redo(process.cwd());
    console.log(chalk.green(`✔ Redid '${result.redone}': ${result.details}`));
    for (const warning of result.warnings ?? []) {
      console.log(chalk.yellow(`⚠ ${warning}`));
    }
  });

program
  .command('submit')
  .description(
    'Push branches and create/update GitHub PRs for the current stack',
  )
  .option('--dry-run', 'Print what would happen without executing')
  .option('-i, --ai', 'AI-generate a PR description for this invocation')
  .option('--no-ai', 'Disable AI PR description generation for this invocation')
  .option('--draft', 'Create new PRs as drafts')
  .option(
    '--publish',
    'Promote existing draft PRs in the submit scope to ready for review',
  )
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
  .option('--web', 'Open GitHub PR create forms in the browser for new PRs')
  .option(
    '--merge-when-ready',
    'Queue GitHub auto-merge for every submitted PR',
  )
  .option(
    '--method <method>',
    'Auto-merge strategy: merge|squash|rebase',
    parseMergeMethod,
  )
  .option(
    '--reviewers <list>',
    'Comma-separated GitHub users or teams to request for review',
  )
  .option('--no-reviewers', 'Skip repo-default reviewers for this submit')
  .option(
    '--rerequest-review',
    'Re-request review from existing reviewers on updated PRs',
  )
  .option(
    '--rerequest-review-only <users>',
    'Re-request review only from comma-separated reviewers on updated PRs',
    parseReviewerList,
  )
  .addHelpText(
    'after',
    `
Examples:
  $ dub submit              Push current branch + ancestors and create/update PRs (default)
  $ dub submit --upstack    Push current branch + all descendants
  $ dub submit --stack      Push every branch in the stack (trees supported)
  $ dub submit --branch foo Push only the 'foo' branch
  $ dub submit --dry-run    Preview what would happen
  $ dub submit --draft      Create new PRs as drafts
  $ dub submit --publish    Promote existing draft PRs to ready for review
  $ dub submit --ai         Generate a PR description before updating the PR body
  $ dub submit --reviewers alice,bob,@org/team
                            Request reviewers for every submitted PR
  $ dub submit --web        Open browser PR create forms for new PRs
  $ dub submit --merge-when-ready --method squash
                            Queue GitHub auto-merge for submitted PRs
  $ dub submit --rerequest-review
                            Re-request review on updated PRs

See also:
  dub ss, dub ready, dub merge-next, dub merge-check, dub pr`,
  )
  .action(runSubmit);

program
  .command('ss')
  .description('Submit the current stack (alias for submit)')
  .addHelpText(
    'after',
    `
Examples:
  $ dub ss               Submit downstack (current branch + ancestors)
  $ dub ss --stack       Submit the full stack tree
  $ dub ss --dry-run     Preview the push/PR plan without executing

See also:
  dub submit, dub ready, dub merge-next`,
  )
  .option('--dry-run', 'Print what would happen without executing')
  .option('-i, --ai', 'AI-generate a PR description for this invocation')
  .option('--no-ai', 'Disable AI PR description generation for this invocation')
  .option('--draft', 'Create new PRs as drafts')
  .option(
    '--publish',
    'Promote existing draft PRs in the submit scope to ready for review',
  )
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
  .option('--web', 'Open GitHub PR create forms in the browser for new PRs')
  .option(
    '--merge-when-ready',
    'Queue GitHub auto-merge for every submitted PR',
  )
  .option(
    '--method <method>',
    'Auto-merge strategy: merge|squash|rebase',
    parseMergeMethod,
  )
  .option(
    '--reviewers <list>',
    'Comma-separated GitHub users or teams to request for review',
  )
  .option('--no-reviewers', 'Skip repo-default reviewers for this submit')
  .option(
    '--rerequest-review',
    'Re-request review from existing reviewers on updated PRs',
  )
  .option(
    '--rerequest-review-only <users>',
    'Re-request review only from comma-separated reviewers on updated PRs',
    parseReviewerList,
  )
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
  .option('--json', 'Output merge-check results as JSON')
  .addHelpText(
    'after',
    `
Examples:
  $ dub merge-check                       Check the current branch's PR
  $ dub merge-check --scope downstack     Check current branch + ancestors
  $ dub merge-check --scope stack         Check every branch in the stack
  $ dub merge-check --pr 123              Check a specific PR (scope ignored)
  $ dub merge-check --json                Emit structured JSON (exits 1 on failure)

See also:
  dub merge-next, dub ready, dub submit`,
  )
  .action(
    async (options: {
      pr?: number;
      branch?: string;
      scope: ScopeMode;
      json?: boolean;
    }) => {
      if (options.json) {
        activateJsonMode();
        const result = await runMergeCheck(process.cwd(), {
          pr: options.pr,
          branch: options.branch,
          scope: options.scope,
        });
        console.log(JSON.stringify(withSchemaVersion(result), null, 2));
        if (!result.ok) {
          process.exitCode = 1;
        }
        return;
      }
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
  .addHelpText(
    'after',
    `
Examples:
  $ dub post-merge                Repair the current stack after a merge
  $ dub post-merge --all          Process every tracked stack
  $ dub post-merge --dry-run      Preview cleanup + retarget without mutating
  $ dub post-merge --no-restack   Skip restacking remaining branches

See also:
  dub merge-next, dub sync, dub restack`,
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
  .addHelpText(
    'after',
    `
Examples:
  $ dub merge-next                       Merge the next eligible PR + run post-merge
  $ dub land                             Alias for 'dub merge-next'
  $ dub merge-next --method squash       Squash-merge (default)
  $ dub merge-next --queue               Enqueue in the GitHub merge queue
  $ dub merge-next --dry-run             Preview the merge + retarget plan

See also:
  dub submit, dub merge-check, dub post-merge, dub ready`,
  )
  .option('--dry-run', 'Preview merge + post-merge actions')
  .option('--queue', 'Use GitHub native merge queue when merging')
  .option('--no-queue', 'Force direct merge even when merge queue is enabled')
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
      queue?: boolean;
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
        if (result.mode === 'queue') {
          console.log(
            chalk.green(
              `✔ Dry-run: would enqueue '${result.mergedBranch}' (PR #${result.prNumber}) to the merge queue.`,
            ),
          );
          printSiblingHint();
          return;
        }
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
      if (result.mode === 'queue') {
        console.log(
          chalk.green(`✔ Enqueued PR #${result.prNumber} to merge queue.`),
        );
        console.log(
          chalk.dim(
            '  Run `dub sync` after the queue processes to update local state.',
          ),
        );
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
  .option('--json', 'Output doctor results as JSON')
  .addHelpText(
    'after',
    `
Examples:
  $ dub doctor              Health-check the current stack
  $ dub doctor --all        Health-check every tracked stack
  $ dub doctor --no-fetch   Skip the remote fetch (offline / fast path)
  $ dub doctor --json       Emit machine-readable results

See also:
  dub status, dub prune, dub sync`,
  )
  .action(
    async (options: { all?: boolean; fetch?: boolean; json?: boolean }) => {
      if (options.json) activateJsonMode();
      const result = await doctor(process.cwd(), options);
      if (options.json) {
        console.log(JSON.stringify(withSchemaVersion(result), null, 2));
        return;
      }
      if (result.issues.length === 0) {
        console.log(
          chalk.green(`✔ No issues found for '${result.checkedBranch}'.`),
        );
      } else {
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
      }
      for (const notice of result.notices) {
        console.log(chalk.blue(`ℹ [${notice.code}] ${notice.summary}`));
        console.log(chalk.dim(`  ${notice.details}`));
        for (const branch of notice.branches) {
          console.log(chalk.dim(`  ↳ ${branch}`));
        }
      }
    },
  );

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
  $ dub status --no-pr        Skip the PR fetch (shell prompts without gh)

See also:
  dub log, dub info, dub doctor, dub watch`,
  )
  .action(async (options: { json?: boolean; live?: boolean; pr?: boolean }) => {
    if (options.json) activateJsonMode();
    const result = await status(process.cwd(), {
      live: options.live,
      pr: options.pr,
    });
    if (options.json) {
      // status already includes `schemaVersion: 1` inline; wrap defensively
      // so the helper stays the single point of truth for the version.
      console.log(JSON.stringify(withSchemaVersion(result), null, 2));
      return;
    }
    console.log(formatStatus(result));
  });

program
  .command('ready')
  .description('Run health + submit preflight checks for the current branch')
  .option('--ai', 'Run an AI review-readiness check before submit')
  .option(
    '--ai-skip-review',
    'Warn but do not block when the AI readiness check finds critical issues',
  )
  .option('--json', 'Output ready status as JSON')
  .option('--verbose', 'Show the full AI readiness issue list')
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
  $ dub ready --scope stack      Check every branch in the stack
  $ dub ready --ai               Run AI review-readiness checks
  $ dub ready --ai --scope stack Run AI checks for every branch in the stack

See also:
  dub doctor, dub submit, dub merge-check`,
  )
  .action(
    async (options: {
      scope: ScopeMode;
      ai?: boolean;
      aiSkipReview?: boolean;
      json?: boolean;
      verbose?: boolean;
    }) => {
      if (options.json) activateJsonMode();
      const result = await ready(process.cwd(), {
        scope: options.scope,
        ai: options.ai,
        aiSkipReview: options.aiSkipReview,
      });
      if (options.json) {
        console.log(JSON.stringify(withSchemaVersion(result), null, 2));
        // Mirror the non-JSON contract: any blocker (doctor failures, missing
        // submit preflight, ai-review) flips the exit code so scripts can
        // gate on `dub ready --json` without re-parsing the result.
        if (!result.ready) {
          process.exitCode = 1;
        }
        return;
      }
      console.log(chalk.dim(`Branch: ${result.checkedBranch}`));
      if (result.submitBranches.length > 0) {
        console.log(
          chalk.dim(
            `Submit scope (${result.scope}): ${result.submitBranches.join(' -> ')} (trunk: ${result.rootBranch})`,
          ),
        );
      }
      printReadyAiReview(result.aiReview, Boolean(options.verbose));
      if (result.ready) {
        console.log(chalk.green('✔ Ready to submit.'));
        return;
      }
      console.log(chalk.yellow('⚠ Not ready to submit yet.'));
      for (const blocker of result.blockers) {
        console.log(chalk.yellow(`  - ${blocker}`));
      }
      if (result.blockers.includes('ai-review')) {
        process.exitCode = 1;
      }
    },
  );

program
  .command('prune')
  .description(
    'Preview or remove stale tracked branches from DubStack metadata',
  )
  .option('--apply', 'Apply pruning changes (default is preview only)')
  .option('-a, --all', 'Prune stale tracked branches across all stacks')
  .option('--no-fetch', 'Skip remote fetch before pruning checks')
  .addHelpText(
    'after',
    `
Examples:
  $ dub prune              Preview stale tracked branches
  $ dub prune --apply      Apply the prune and remove stale metadata
  $ dub prune --all        Scan every tracked stack
  $ dub prune --no-fetch   Skip the remote fetch (offline / fast path)

See also:
  dub doctor, dub untrack, dub delete`,
  )
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
  .addHelpText(
    'after',
    `
Examples:
  $ dub co                       Open the interactive branch picker
  $ dub co feat/auth-login       Checkout a specific branch by name
  $ dub co --trunk               Jump back to the current trunk
  $ dub co --stack               Picker scoped to ancestors + descendants
  $ dub co --all                 Picker showing every tracked stack
  $ dub co --show-untracked      Include untracked git branches in the picker

See also:
  dub back, dub up, dub down, dub top, dub bottom`,
  )
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
  .addHelpText(
    'after',
    `
Examples:
  $ dub skills add              Install every agent skill into this repo
  $ dub skills add dubstack     Install just the dubstack skill
  $ dub skills remove           Remove every installed skill

See also:
  dub config ai-assistant, dub ai setup`,
  )
  .addCommand(
    new Command('add')
      .description('Install agent skills (e.g. dubstack, dub-flow)')
      .argument('[skills...]', 'Names of skills to install (default: all)')
      .option('-g, --global', 'Install skills globally')
      .option('--dry-run', 'Preview actions without installing')
      .addHelpText(
        'after',
        `
Examples:
  $ dub skills add                  Install every available skill into this repo
  $ dub skills add dubstack         Install just the dubstack skill
  $ dub skills add --global         Install skills to your user-level Claude dir
  $ dub skills add --dry-run        Preview which files would be written

See also:
  dub skills remove`,
      )
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
      .addHelpText(
        'after',
        `
Examples:
  $ dub skills remove                Remove every installed skill from this repo
  $ dub skills remove dub-flow       Remove a specific skill
  $ dub skills remove --global       Remove user-level installed skills

See also:
  dub skills add`,
      )
      .action(async (skills, options) => {
        const { removeSkills } = await import('./commands/skills');
        await removeSkills(skills, options);
      }),
  );

program
  .command('config')
  .description('Manage DubStack configuration')
  .addHelpText(
    'after',
    `
Examples:
  $ dub config theme dark              Pin to a dark-background palette
  $ dub config ai-assistant on         Enable AI features for this repo
  $ dub config reviewers alice,bob     Set repo-default PR reviewers
  $ dub config storage-backend sqlite  Switch to the SQLite backend
  $ dub config submit-default draft    Open new submit PRs as drafts

See also:
  dub ai setup, dub migrate storage, dub init`,
  )
  .addCommand(
    new Command('ai-assistant')
      .argument('[state]', 'Set to on/off (omit to inspect current value)')
      .description('Enable or disable the repo-local AI assistant')
      .addHelpText(
        'after',
        `
Examples:
  $ dub config ai-assistant        Show the current setting
  $ dub config ai-assistant on     Enable AI features for this repo
  $ dub config ai-assistant off    Disable AI features for this repo

See also:
  dub config ai-provider, dub config ai-defaults`,
      )
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
      .addHelpText(
        'after',
        `
Examples:
  $ dub config ai-defaults create on     AI-generate branch + commit by default
  $ dub config ai-defaults submit on     AI-generate PR descriptions by default
  $ dub config ai-defaults flow on       Default \`dub flow\` to AI mode

See also:
  dub config ai-assistant, dub config ai-prompts`,
      )
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
    new Command('ai-prompts')
      .argument('[mode]', 'Set to auto/on/off (omit to inspect current value)')
      .description('Manage AI choices in interactive prompts')
      .addHelpText(
        'after',
        `
Examples:
  $ dub config ai-prompts auto    Show AI choices when the assistant is enabled
  $ dub config ai-prompts on      Always offer AI choices in prompts
  $ dub config ai-prompts off     Never offer AI choices in prompts

See also:
  dub config ai-prompts-auto-accept, dub config ai-assistant`,
      )
      .action(async (mode?: string) => {
        const { configAiPrompts } = await import('./commands/config');
        const result = await configAiPrompts(process.cwd(), mode);

        if (!mode) {
          console.log(
            chalk.blue(
              `AI prompt choices are '${result.mode}' for this repository.`,
            ),
          );
          return;
        }

        if (result.changed) {
          console.log(
            chalk.green(`✔ AI prompt choices set to '${result.mode}'`),
          );
        } else {
          console.log(
            chalk.yellow(`⚠ AI prompt choices are already '${result.mode}'`),
          );
        }
      }),
  )
  .addCommand(
    new Command('ai-prompts-auto-accept')
      .argument('[level]', 'Set to off/high (omit to inspect current value)')
      .description('Manage AI prompt recommendation auto-accept behavior')
      .addHelpText(
        'after',
        `
Examples:
  $ dub config ai-prompts-auto-accept off    Always confirm AI recommendations
  $ dub config ai-prompts-auto-accept high   Auto-apply high-confidence picks

See also:
  dub config ai-prompts`,
      )
      .action(async (level?: string) => {
        const { configAiPromptsAutoAccept } = await import('./commands/config');
        const result = await configAiPromptsAutoAccept(process.cwd(), level);

        if (!level) {
          console.log(
            chalk.blue(
              `AI prompt auto-accept is '${result.autoAccept}' for this repository.`,
            ),
          );
          return;
        }

        if (result.changed) {
          console.log(
            chalk.green(
              `✔ AI prompt auto-accept set to '${result.autoAccept}'`,
            ),
          );
        } else {
          console.log(
            chalk.yellow(
              `⚠ AI prompt auto-accept is already '${result.autoAccept}'`,
            ),
          );
        }
      }),
  )
  .addCommand(
    new Command('ai-provider')
      .argument(
        '[provider]',
        'Set to auto/gemini/anthropic/gateway/bedrock/openai/ollama (omit to inspect current value)',
      )
      .description('Manage the repo-local AI provider selection')
      .addHelpText(
        'after',
        `
Examples:
  $ dub config ai-provider auto         Pick a provider from configured env keys
  $ dub config ai-provider anthropic    Force the Anthropic provider
  $ dub config ai-provider gemini       Force Google's Gemini provider
  $ dub config ai-provider ollama       Use a local Ollama server

See also:
  dub config ai-model, dub ai setup, dub ai env`,
      )
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
      .addHelpText(
        'after',
        `
Examples:
  $ dub config mcp-mode read-only      Disable mutating MCP tools entirely
  $ dub config mcp-mode interactive    Require terminal confirmation (default)
  $ dub config mcp-mode trusted        Let mutating MCP tools run without prompts

See also:
  dub mcp`,
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
    new Command('reviewers')
      .argument('[list]', 'Comma-separated GitHub users or teams')
      .option('--clear', 'Remove repo-default reviewers')
      .description('Manage repo-default PR reviewers')
      .addHelpText(
        'after',
        `
Examples:
  $ dub config reviewers                       Show repo-default reviewers
  $ dub config reviewers alice,@org/backend    Set default reviewers
  $ dub config reviewers --clear               Remove all repo-default reviewers

See also:
  dub submit --reviewers, dub submit --no-reviewers`,
      )
      .action(
        async (list: string | undefined, options: { clear?: boolean }) => {
          const { configReviewers } = await import('./commands/config');
          const { formatReviewers } = await import('./lib/reviewers');
          const result = await configReviewers(process.cwd(), list, {
            clear: options.clear,
          });

          if (!options.clear && list == null) {
            console.log(
              chalk.blue(
                result.reviewers.length > 0
                  ? `Default reviewers: ${formatReviewers(result.reviewers)}`
                  : 'No default reviewers configured for this repository.',
              ),
            );
            return;
          }

          if (result.changed) {
            console.log(
              chalk.green(
                result.reviewers.length > 0
                  ? `✔ Default reviewers set: ${formatReviewers(result.reviewers)}`
                  : '✔ Default reviewers cleared',
              ),
            );
          } else {
            console.log(
              chalk.yellow(
                result.reviewers.length > 0
                  ? `⚠ Default reviewers already set: ${formatReviewers(result.reviewers)}`
                  : '⚠ No default reviewers were configured',
              ),
            );
          }
        },
      ),
  )
  .addCommand(
    new Command('storage-backend')
      .argument(
        '[backend]',
        'Set to json/sqlite (omit to inspect current value)',
      )
      .description('Manage the repo-local state storage backend')
      .addHelpText(
        'after',
        `
Examples:
  $ dub config storage-backend         Show the current backend
  $ dub config storage-backend json    Switch to the JSON backend (default)
  $ dub config storage-backend sqlite  Switch to the SQLite backend

See also:
  dub migrate storage`,
      )
      .action(async (backend?: string) => {
        const { configStorageBackend } = await import('./commands/config');
        const result = await configStorageBackend(process.cwd(), backend);

        if (!backend) {
          console.log(
            chalk.blue(
              `Storage backend is '${result.backend}' for this repository.`,
            ),
          );
          return;
        }

        if (result.changed) {
          console.log(
            chalk.green(`✔ Storage backend set to '${result.backend}'`),
          );
        } else {
          console.log(
            chalk.yellow(`⚠ Storage backend is already '${result.backend}'`),
          );
        }
      }),
  )
  .addCommand(
    new Command('submit-default')
      .argument(
        '[mode]',
        'Set to auto/draft/publish (omit to inspect current value)',
      )
      .description('Manage the repo-local submit PR lifecycle default')
      .addHelpText(
        'after',
        `
Examples:
  $ dub config submit-default auto      Auto-pick draft when CI workflows exist
  $ dub config submit-default draft     Open new PRs as drafts by default
  $ dub config submit-default publish   Promote existing draft PRs by default

See also:
  dub submit --draft, dub submit --publish`,
      )
      .action(async (mode?: string) => {
        const { configSubmitDefault } = await import('./commands/config');
        const result = await configSubmitDefault(process.cwd(), mode);

        if (!mode) {
          console.log(
            chalk.blue(
              `Submit default is '${result.mode}' for this repository.`,
            ),
          );
          return;
        }

        if (result.changed) {
          console.log(chalk.green(`✔ Submit default set to '${result.mode}'`));
        } else {
          console.log(
            chalk.yellow(`⚠ Submit default is already '${result.mode}'`),
          );
        }
      }),
  )
  .addCommand(
    new Command('theme')
      .argument(
        '[mode]',
        'Set to auto/dark/light/none (omit to inspect current value)',
      )
      .description(
        'Manage the terminal color theme used in log, status, and sync output',
      )
      .addHelpText(
        'after',
        `
Examples:
  $ dub config theme              Show the configured theme
  $ dub config theme auto         Auto-detect light/dark from COLORFGBG (default)
  $ dub config theme dark         Pin to a dark-background palette
  $ dub config theme light        Pin to a light-background palette
  $ dub config theme none         Disable colors (equivalent to --no-color)

See also:
  dub log, dub status, dub sync`,
      )
      .action(async (mode?: string) => {
        const { configTheme } = await import('./commands/config');
        const result = await configTheme(process.cwd(), mode);

        if (!mode) {
          console.log(
            chalk.blue(`Theme is '${result.theme}' for this repository.`),
          );
          return;
        }

        if (result.changed) {
          console.log(chalk.green(`✔ Theme set to '${result.theme}'`));
        } else {
          console.log(chalk.yellow(`⚠ Theme is already '${result.theme}'`));
        }
      }),
  )
  .addCommand(
    new Command('ai-model')
      .argument('[model]', 'Set repo-local model override (omit to inspect)')
      .requiredOption(
        '--provider <provider>',
        'Provider name: gemini, anthropic, gateway, bedrock, openai, or ollama',
      )
      .option('--clear', 'Clear the repo-local model override')
      .description('Manage repo-local AI model overrides by provider')
      .addHelpText(
        'after',
        `
Examples:
  $ dub config ai-model --provider anthropic claude-sonnet-4-7
  $ dub config ai-model --provider gemini gemini-2.5-pro
  $ dub config ai-model --provider openai --clear

See also:
  dub config ai-provider, dub ai env, dub ai setup`,
      )
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
  .command('migrate')
  .description('Migrate DubStack repo-local data between storage formats')
  .addHelpText(
    'after',
    `
Examples:
  $ dub migrate storage --to sqlite    Move state.json into state.sqlite
  $ dub migrate storage --to json      Move state.sqlite back to state.json

See also:
  dub config storage-backend`,
  )
  .addCommand(
    new Command('storage')
      .requiredOption('--to <backend>', 'Storage backend: json or sqlite')
      .description('Copy DubStack state and switch the configured backend')
      .addHelpText(
        'after',
        `
Examples:
  $ dub migrate storage --to sqlite    Copy state.json into state.sqlite and opt in
  $ dub migrate storage --to json      Copy state.sqlite back to state.json

See also:
  dub config storage-backend, dub init`,
      )
      .action(async (options: { to: string }) => {
        const result = await migrateStorage(process.cwd(), options.to);
        const summary = `${result.stackCount} stack${result.stackCount === 1 ? '' : 's'}, ${result.branchCount} branch${result.branchCount === 1 ? '' : 'es'}`;

        if (result.changed) {
          console.log(
            chalk.green(
              `✔ Migrated storage from '${result.from}' to '${result.to}' (${summary})`,
            ),
          );
        } else {
          console.log(
            chalk.yellow(
              `⚠ Storage backend is already '${result.to}' (${summary})`,
            ),
          );
        }
      }),
  );

program
  .command('ai')
  .description(
    'Use DubStack AI assistant utilities (or shortcut with: dub PROMPT)',
  )
  .addHelpText(
    'after',
    `
Examples:
  $ dub ai setup                       Interactive provider + model setup
  $ dub ai ask "summarize this stack"  Ask the assistant a question
  $ dub ai env --anthropic-key sk-...  Write Anthropic env exports
  $ dub ai resolve                     Resolve in-progress conflicts via AI

See also:
  dub config ai-assistant, dub flow`,
  )
  .addCommand(
    new Command('setup')
      .description('Guided setup for DubStack AI providers and model defaults')
      .addHelpText(
        'after',
        `
Examples:
  $ dub ai setup    Interactively pick a provider and write env exports

See also:
  dub ai env, dub config ai-provider, dub config ai-model`,
      )
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
      .addHelpText(
        'after',
        `
Examples:
  $ dub ai ask "what changed in this stack?"
  $ dub ai ask "draft a PR description for this branch"
  $ dub ai ask "is this stack ready to land?"

See also:
  dub ai resolve, dub ai setup, dub flow`,
      )
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
      .option('--anthropic-key <key>', 'Set DUBSTACK_ANTHROPIC_API_KEY')
      .option('--gateway-key <key>', 'Set DUBSTACK_AI_GATEWAY_API_KEY')
      .option('--openai-key <key>', 'Set DUBSTACK_OPENAI_API_KEY')
      .option('--ollama-base-url <url>', 'Set DUBSTACK_OLLAMA_BASE_URL')
      .option('--gemini-model <model>', 'Set DUBSTACK_GEMINI_MODEL')
      .option('--anthropic-model <model>', 'Set DUBSTACK_ANTHROPIC_MODEL')
      .option('--gateway-model <model>', 'Set DUBSTACK_AI_GATEWAY_MODEL')
      .option('--openai-model <model>', 'Set DUBSTACK_OPENAI_MODEL')
      .option('--ollama-model <model>', 'Set DUBSTACK_OLLAMA_MODEL')
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
      .addHelpText(
        'after',
        `
Examples:
  $ dub ai env --anthropic-key sk-...
  $ dub ai env --gemini-key ... --gemini-model gemini-2.5-pro
  $ dub ai env --ollama-base-url http://localhost:11434 --ollama-model qwen2.5-coder

See also:
  dub ai setup, dub config ai-provider`,
      )
      .action(
        async (options: {
          geminiKey?: string;
          anthropicKey?: string;
          gatewayKey?: string;
          openaiKey?: string;
          ollamaBaseUrl?: string;
          geminiModel?: string;
          anthropicModel?: string;
          gatewayModel?: string;
          openaiModel?: string;
          ollamaModel?: string;
          bedrockProfile?: string;
          bedrockRegion?: string;
          bedrockModel?: string;
          profile?: string;
          shell?: string;
        }) => {
          const { configureAiEnv } = await import('./commands/ai-env');
          const result = await configureAiEnv({
            geminiKey: options.geminiKey,
            anthropicKey: options.anthropicKey,
            gatewayKey: options.gatewayKey,
            openaiKey: options.openaiKey,
            ollamaBaseUrl: options.ollamaBaseUrl,
            geminiModel: options.geminiModel,
            anthropicModel: options.anthropicModel,
            gatewayModel: options.gatewayModel,
            openaiModel: options.openaiModel,
            ollamaModel: options.ollamaModel,
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
      .option(
        '--adjudicate',
        'Resolve conflicts with two configured AI providers',
      )
      .option('--no-adjudicate', 'Use one configured AI provider')
      .addHelpText(
        'after',
        `
Examples:
  $ dub ai resolve              Resolve in-progress rebase/restack conflicts
  $ dub ai resolve --dry-run    Show proposed resolutions without applying
  $ dub ai resolve --adjudicate Pit two providers against each other

See also:
  dub continue --ai, dub abort, dub restack`,
      )
      .action(
        async (options: {
          dryRun?: boolean;
          abort?: boolean;
          adjudicate?: boolean;
        }) => {
          const { aiResolve } = await import('./commands/ai-resolve');
          await aiResolve(process.cwd(), {
            dryRun: options.dryRun,
            abort: options.abort,
            adjudicate: options.adjudicate,
          });
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
  .addHelpText(
    'after',
    `
Examples:
  $ dub history             Show the 20 most recent dub commands
  $ dub history -n 50       Show the last 50 entries
  $ dub history --json      Emit JSON (for downstream tooling)

See also:
  dub status, dub doctor`,
  )
  .action(async (options: { limit?: number; json?: boolean }) => {
    if (options.json) activateJsonMode();
    const { formatHistory, history } = await import('./commands/history');
    const result = await history(process.cwd(), {
      limit: options.limit ?? 20,
    });

    if (options.json) {
      console.log(JSON.stringify(withSchemaVersion(result), null, 2));
      return;
    }

    console.log(formatHistory(result));
  });

program
  .command('mcp')
  .description(
    'Start the DubStack MCP server over stdio (mutating tools gated by `dub config mcp-mode`)',
  )
  .addHelpText(
    'after',
    `
Examples:
  $ dub mcp    Speak Model Context Protocol over stdio (used by AI agents)

See also:
  dub config mcp-mode`,
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
  .option(
    '--dry-run',
    'Print the planned modify without staging, committing, or restacking',
  )
  .option('--json', 'Pair with --dry-run to emit the plan as JSON')
  // .option("--into <branch>", "Amend staged changes to the specified branch") // TODO: Implement --into
  // .option("--reset-author", "Set the author to the current user") // TODO: Implement --reset-author
  // .option("-v, --verbose", "Show unified diff") // TODO: Implement verbose
  .addHelpText(
    'after',
    `
Examples:
  $ dub modify -a                       Amend HEAD with all working-tree changes
  $ dub modify -c -a -m "feat: foo"     Add a new commit (stage all) on this branch
  $ dub modify -p                       Pick hunks to amend with
  $ dub modify --interactive-rebase     Interactively rebase the branch commits

See also:
  dub create, dub squash, dub split, dub absorb`,
  )
  .action(async (options) => {
    const { modify } = await import('./commands/modify');
    const normalizedOptions = {
      ...options,
      message:
        Array.isArray(options.message) && options.message.length === 1
          ? options.message[0]
          : options.message,
    };
    const result = await modify(process.cwd(), normalizedOptions);
    if (result && 'dryRun' in result && result.dryRun) {
      if (options.json) {
        emitDryRunPlan(result);
        return;
      }
      console.log(
        chalk.green(
          `✔ Dry-run: would ${result.action} on '${result.branch}'${result.message ? ` • ${result.message.split('\n')[0]}` : ''}`,
        ),
      );
      if (result.descendantsToRestack.length > 0) {
        console.log(
          chalk.dim(
            `  ↳ would restack ${result.descendantsToRestack.length} descendant(s)`,
          ),
        );
      }
    }
  });

program
  .command('squash')
  .description(
    'Collapse every commit on the current branch (since its parent) into one',
  )
  .option('-m, --message <message>', 'Use the given message for the new commit')
  .option(
    '--ai',
    'Generate a Conventional Commit summary from the squashed commits',
  )
  .option(
    '--dry-run',
    'Print the planned squash without resetting or committing',
  )
  .option('--json', 'Pair with --dry-run to emit the plan as JSON')
  .addHelpText(
    'after',
    `
Examples:
  $ dub squash                          Squash and concatenate original messages
  $ dub squash -m "feat: rewrite api"   Squash with a custom commit message
  $ dub squash --ai                     Squash with an AI-generated summary
  $ dub squash --dry-run                Preview the plan without mutating

See also:
  dub fold, dub modify, dub absorb`,
  )
  .action(
    async (options: {
      message?: string;
      ai?: boolean;
      dryRun?: boolean;
      json?: boolean;
    }) => {
      const result = await squash(process.cwd(), {
        message: options.message,
        ai: options.ai,
        dryRun: options.dryRun,
      });

      if (result.dryRun) {
        if (options.json) {
          emitDryRunPlan(result);
          return;
        }
        if (result.noopReason) {
          console.log(
            chalk.dim(
              `Dry-run: nothing to squash on '${result.branch}' (${result.noopReason}).`,
            ),
          );
          return;
        }
        console.log(
          chalk.green(
            `✔ Dry-run: would squash ${result.squashedCommits} commit(s) on '${result.branch}' into '${result.parent}'`,
          ),
        );
        return;
      }

      if (result.noopReason === 'no-commits') {
        console.log(
          chalk.dim(
            `Nothing to squash — '${result.branch}' has no commits above '${result.parent}'.`,
          ),
        );
        return;
      }
      if (result.noopReason === 'single-commit') {
        console.log(
          chalk.dim(
            `Nothing to squash — '${result.branch}' already has a single commit above '${result.parent}'.`,
          ),
        );
        return;
      }

      console.log(
        chalk.green(
          `✔ Squashed ${result.squashedCommits} commit(s) on '${result.branch}' into one.`,
        ),
      );
      if (result.restacked) {
        console.log(chalk.dim('  ↳ Descendants restacked.'));
      }
    },
  );

program
  .command('split')
  .description(
    'Split the current branch into smaller sibling branches (by-commit, by-file, by-hunk, or AI)',
  )
  .option(
    '--by-commit',
    'Interactively pick commits to extract to a new branch',
  )
  .option(
    '--commit-picks <indices>',
    "For '--by-commit': skip the prompt and use these 1-indexed positions (e.g. '1,3-4')",
  )
  .option(
    '--by-file <files...>',
    'Non-interactive: move specific files to a new branch (requires --name)',
  )
  .option(
    '--by-hunk',
    "Interactively pick hunks via `git reset --patch` (answer 'y' to move a hunk back to source, 'n' to keep it on the new branch)",
  )
  .option('--ai', 'Ask the AI assistant to propose a semantic split')
  .option('--name <branch>', 'New branch name for the extracted slice')
  .option(
    '--close-old-pr',
    "Close the source branch's existing PR (Graphite-style); by default it's left for `dub submit` to force-push",
  )
  .option(
    '--no-restack',
    'Skip the automatic restack of descendants after the split',
  )
  .option(
    '--dry-run',
    'Preview the planned split without mutating refs, state, or PRs',
  )
  .option('--json', 'Pair with --dry-run to emit the plan as JSON')
  .option('-y, --yes', 'AI mode only: skip the approval prompt')
  .option('--no-interactive', 'Disable interactive prompts and require flags')
  .addHelpText(
    'after',
    `
Examples:
  $ dub split --by-file packages/cli/src/lib/foo.ts --name feat/foo
  $ dub split --by-commit                          Interactive numbered checklist
  $ dub split --by-hunk                            Interactive 'git reset --patch' style
  $ dub split --ai                                 AI-propose a semantic split

PR handling:
  • By default the source branch's existing PR is left intact; the next 'dub submit'
    force-pushes the new (smaller) shape and the new branches get their own PRs.
  • Pass --close-old-pr for Graphite-style "close old + create new on submit".
  • If the split leaves the source branch empty vs its parent, the old PR is
    closed automatically (GitHub rejects PRs with no diff) with a comment
    linking to the new branches.

After the split, 'dub restack' runs automatically so any descendants follow
the source branch's new tip. Pass '--no-restack' to skip that step.

See also:
  dub reorder, dub modify, dub absorb, dub move`,
  )
  .action(runSplit);

program
  .command('pop')
  .description(
    'Pop the last commit(s) off the current branch into the staging area',
  )
  .option(
    '-n, --steps <count>',
    'Number of commits to pop (default: 1)',
    parsePositiveInt,
  )
  .option('--dry-run', 'Print the planned pop without resetting HEAD')
  .option('--json', 'Pair with --dry-run to emit the plan as JSON')
  .addHelpText(
    'after',
    `
Examples:
  $ dub pop                Pop last commit into staged changes
  $ dub pop --steps 3      Squash last 3 commits into staged changes
  $ dub pop && dub m -a -m "..."   Pop, edit, re-commit (descendants restack lazily)
  $ dub pop --dry-run      Preview the plan without mutating

See also:
  dub modify, dub split, dub undo`,
  )
  .action(
    async (options: { steps?: number; dryRun?: boolean; json?: boolean }) => {
      const result = await pop(process.cwd(), {
        steps: options.steps,
        dryRun: options.dryRun,
      });
      if (result.dryRun) {
        if (options.json) {
          emitDryRunPlan(result);
          return;
        }
        console.log(
          chalk.green(
            `✔ Dry-run: would pop ${result.steps} commit(s) from '${result.branch}'`,
          ),
        );
        return;
      }
      const noun = result.steps === 1 ? 'commit' : 'commits';
      console.log(
        chalk.green(
          `✔ Popped ${result.steps} ${noun} from '${result.branch}' into staged changes`,
        ),
      );
      console.log(
        chalk.dim(
          '  Edit, then run \'dub modify -a -m "<message>"\' to recommit. Descendants restack on next modify.',
        ),
      );
    },
  );

program
  .command('reorder')
  .description(
    'Interactively reorder or drop commits within the current branch',
  )
  .option(
    '--dry-run',
    'Print the reorderable commits without launching the picker',
  )
  .option('--json', 'Pair with --dry-run to emit the plan as JSON')
  .addHelpText(
    'after',
    `
Examples:
  $ dub reorder              Open the picker for the current branch's commits
  $ dub reorder --dry-run    Preview the reorderable commits without launching the picker

See also:
  dub modify, dub split, dub move`,
  )
  .action(async (options: { dryRun?: boolean; json?: boolean }) => {
    const result = await reorder(process.cwd(), { dryRun: options.dryRun });

    if (result.dryRun) {
      if (options.json) {
        emitDryRunPlan(result);
        return;
      }
      console.log(
        chalk.green(
          `✔ Dry-run: ${result.reorderableCommits?.length ?? 0} commit(s) eligible to reorder.`,
        ),
      );
      return;
    }

    if (result.status === 'no-op') {
      console.log(
        chalk.yellow(
          `⚠ Nothing to do: ${result.noOpReason ?? 'no changes in picker'}.`,
        ),
      );
      return;
    }
    if (result.status === 'cancelled') {
      console.log(
        chalk.yellow(
          `⚠ Reorder cancelled${result.noOpReason ? `: ${result.noOpReason}` : ''}.`,
        ),
      );
      return;
    }
    if (result.status === 'exit' || result.status === 'conflict') {
      const isReorderRebase = result.conflictSource === 'reorder';
      const subject = isReorderRebase
        ? `reordering '${result.conflictBranch}'`
        : `restacking descendant '${result.conflictBranch}'`;
      const verb = result.status === 'exit' ? 'left in conflict' : 'Conflict';
      console.log(chalk.yellow(`⚠ ${verb} while ${subject}`));
      if (isReorderRebase) {
        // No `restack-progress.json` was written, so `dub continue` cannot
        // resume on its own — point the user at the underlying git command,
        // then `dub restack` afterwards to rebase descendants.
        console.log(
          chalk.dim(
            '  Resolve conflicts, stage changes, then run: git rebase --continue',
          ),
        );
        console.log(
          chalk.dim(
            "  Once the rebase finishes, run 'dub restack' to rebase descendants.",
          ),
        );
        console.log(
          chalk.dim('  Or run: git rebase --abort, then dub undo, to bail.'),
        );
      } else {
        console.log(
          chalk.dim(
            '  Resolve conflicts, stage changes, then run: dub continue --ai (or dub continue)',
          ),
        );
      }
      return;
    }
    const kept = result.finalPicks.length;
    const dropped = result.dropped.length;
    console.log(
      chalk.green(
        `✔ Reordered ${kept} commit(s)${dropped > 0 ? `, dropped ${dropped}` : ''}`,
      ),
    );
    if (result.rebased.length > 0) {
      console.log(chalk.dim(`  ↳ rebased: ${result.rebased.join(', ')}`));
    }
  });

program
  .command('pr')
  .argument('[branch]', 'Branch name or PR number to open')
  .description('Open a branch PR in your browser')
  .addHelpText(
    'after',
    `
Examples:
  $ dub pr                       Open the PR for the current branch
  $ dub pr feat/auth-login       Open the PR for a specific branch
  $ dub pr 123                   Open PR #123 in the GitHub UI

See also:
  dub submit, dub repo, dub status`,
  )
  .action(async (branch?: string) => {
    await pr(process.cwd(), branch);
  });

program
  .command('freeze')
  .argument('[branch]', 'Branch to freeze (defaults to current branch)')
  .option('--downstack', 'Also freeze ancestors toward trunk')
  .option('--upstack', 'Also freeze descendants')
  .option('--dry-run', 'Print the planned freeze without mutating state')
  .option('--json', 'Pair with --dry-run to emit the plan as JSON')
  .description(
    "Set the 'frozen' flag on a tracked branch so restack/sync/post-merge skip it",
  )
  .addHelpText(
    'after',
    `
Examples:
  $ dub freeze                       Freeze the current branch
  $ dub freeze feat/auth-login       Freeze a specific tracked branch
  $ dub freeze feat/auth-login --downstack   Freeze the branch and its ancestors
  $ dub freeze --upstack             Freeze the current branch and its descendants
  $ dub freeze --dry-run             Preview the plan without mutating

See also:
  dub unfreeze, dub restack`,
  )
  .action(
    async (
      branch: string | undefined,
      options: {
        downstack?: boolean;
        upstack?: boolean;
        dryRun?: boolean;
        json?: boolean;
      },
    ) => {
      const result = await freeze(process.cwd(), branch, {
        downstack: options.downstack,
        upstack: options.upstack,
        dryRun: options.dryRun,
      });
      if (result.dryRun) {
        if (options.json) {
          emitDryRunPlan(result);
          return;
        }
        console.log(
          chalk.green(
            `✔ Dry-run: would freeze ${result.changed.length} branch(es): ${result.changed.join(', ') || '(none)'}`,
          ),
        );
        return;
      }
      printFreezeResult(result, 'frozen');
    },
  );

program
  .command('unfreeze')
  .argument('[branch]', 'Branch to unfreeze (defaults to current branch)')
  .option('--downstack', 'Also unfreeze ancestors toward trunk')
  .option('--upstack', 'Also unfreeze descendants')
  .option('--dry-run', 'Print the planned unfreeze without mutating state')
  .option('--json', 'Pair with --dry-run to emit the plan as JSON')
  .description(
    "Clear the 'frozen' flag so restack/sync/post-merge can mutate the branch again",
  )
  .addHelpText(
    'after',
    `
Examples:
  $ dub unfreeze                     Unfreeze the current branch
  $ dub unfreeze feat/auth-login --upstack    Unfreeze a branch and its descendants
  $ dub unfreeze --dry-run           Preview the plan without mutating

See also:
  dub freeze, dub restack`,
  )
  .action(
    async (
      branch: string | undefined,
      options: {
        downstack?: boolean;
        upstack?: boolean;
        dryRun?: boolean;
        json?: boolean;
      },
    ) => {
      const result = await unfreeze(process.cwd(), branch, {
        downstack: options.downstack,
        upstack: options.upstack,
        dryRun: options.dryRun,
      });
      if (result.dryRun) {
        if (options.json) {
          emitDryRunPlan(result);
          return;
        }
        console.log(
          chalk.green(
            `✔ Dry-run: would unfreeze ${result.changed.length} branch(es): ${result.changed.join(', ') || '(none)'}`,
          ),
        );
        return;
      }
      printFreezeResult(result, 'unfrozen');
    },
  );

program
  .command('rename')
  .argument('<firstName>', 'New name (current branch) or old name')
  .argument('[secondName]', 'New name when renaming a specific tracked branch')
  .description(
    'Rename a tracked branch and propagate the change through state, children, and remote',
  )
  .option('--no-push', 'Skip pushing the renamed branch even if a PR exists')
  .option(
    '--dry-run',
    'Print the planned rename without mutating refs, state, or remote',
  )
  .option('--json', 'Pair with --dry-run to emit the plan as JSON')
  .addHelpText(
    'after',
    `
Examples:
  $ dub rename feat/new-name              Rename the current tracked branch
  $ dub rename feat/old feat/new          Rename a specific tracked branch
  $ dub rename --no-push feat/new-name    Rename without pushing the renamed branch
  $ dub rename feat/new --dry-run         Preview the plan without mutating

See also:
  dub track, dub submit, dub pr`,
  )
  .action(
    async (
      firstName: string,
      secondName: string | undefined,
      options: { push?: boolean; dryRun?: boolean; json?: boolean },
    ) => {
      const result = await rename(process.cwd(), firstName, secondName, {
        noPush: options.push === false,
        dryRun: options.dryRun,
      });
      if (result.dryRun) {
        if (options.json) {
          emitDryRunPlan(result);
          return;
        }
        console.log(
          chalk.green(
            `✔ Dry-run: would rename '${result.oldName}' to '${result.newName}'`,
          ),
        );
        return;
      }
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

program
  .command('revert')
  .argument('<target>', 'Merged PR number (e.g. 123) or commit SHA to revert')
  .option('-b, --branch <name>', 'Override the auto-generated branch name')
  .option('--submit', 'Push the revert branch and open a PR after creating it')
  .option(
    '--edit-message',
    "Open the editor for the revert commit message instead of '--no-edit'",
  )
  .option(
    '--dry-run',
    'Print the planned revert without creating branches or committing',
  )
  .option('--json', 'Pair with --dry-run to emit the plan as JSON')
  .description(
    'Create a branch on trunk that reverts a merged PR or commit and track it',
  )
  .addHelpText(
    'after',
    `
Examples:
  $ dub revert 123                       Revert merged PR #123 onto trunk
  $ dub revert abc1234                   Revert commit abc1234 onto trunk
  $ dub revert 123 --submit              Revert + push + open a PR
  $ dub revert 123 -b revert/api-rollback  Use a custom branch name
  $ dub revert 123 --dry-run             Preview the plan without mutating

See also:
  dub submit, dub merge-next, dub log`,
  )
  .action(
    async (
      target: string,
      options: {
        branch?: string;
        submit?: boolean;
        editMessage?: boolean;
        dryRun?: boolean;
        json?: boolean;
      },
    ) => {
      const result = await revert(process.cwd(), target, {
        branchName: options.branch,
        submit: options.submit,
        editMessage: options.editMessage,
        dryRun: options.dryRun,
      });
      if (result.dryRun) {
        if (options.json) {
          emitDryRunPlan(result);
          return;
        }
        const origin =
          result.prNumber != null
            ? `PR #${result.prNumber}`
            : `commit ${result.revertedShortSha}`;
        console.log(
          chalk.green(
            `✔ Dry-run: would create revert branch '${result.branch}' on '${result.trunk}' (reverts ${origin})`,
          ),
        );
        return;
      }
      const origin =
        result.prNumber != null
          ? `PR #${result.prNumber}`
          : `commit ${result.revertedShortSha}`;
      console.log(
        chalk.green(
          `✔ Created revert branch '${result.branch}' on '${result.trunk}' (reverts ${origin})`,
        ),
      );
      if (result.submitResult) {
        console.log(
          chalk.dim(
            `  ↳ Submitted: pushed ${result.submitResult.pushed.length}, created ${result.submitResult.created.length}, updated ${result.submitResult.updated.length}`,
          ),
        );
      } else {
        console.log(
          chalk.dim(
            `  ↳ Run 'dub submit' to push the branch and open a PR, or rerun with '--submit'.`,
          ),
        );
      }
    },
  );

const stashCommand = program
  .command('stash')
  .description(
    'Branch-aware stash: capture working tree + record source branch so pop can refuse mismatched branches',
  )
  .option(
    '-m, --message <message>',
    'Override the default stash message (default: branch + timestamp)',
  )
  .option('--list', "Alias for 'dub stash list' — show recorded stashes")
  .option(
    '--dry-run',
    'Print the planned stash without invoking git stash push',
  )
  .option('--json', 'Pair with --dry-run to emit the plan as JSON')
  .addHelpText(
    'after',
    `
Examples:
  $ dub stash                                Stash on current branch
  $ dub stash -m "wip: refactor"             Stash with custom message
  $ dub stash --dry-run                      Preview the plan
  $ dub stash pop                            Pop most recent (same branch only)
  $ dub stash pop --on feat/other            Checkout feat/other, then pop
  $ dub stash pop --force                    Pop onto current branch regardless
  $ dub stash list                           Show recorded stashes with branch context

See also:
  dub stash pop, dub stash list, git stash`,
  )
  .action(
    async (options: {
      message?: string;
      list?: boolean;
      dryRun?: boolean;
      json?: boolean;
    }) => {
      if (options.list) {
        await runStashList();
        return;
      }
      const result = await stashPush(process.cwd(), {
        message: options.message,
        dryRun: options.dryRun,
      });
      if (result.dryRun) {
        if (options.json) {
          emitDryRunPlan(result);
          return;
        }
        console.log(
          chalk.green(`✔ Dry-run: would stash on '${result.branch}'`),
        );
        return;
      }
      console.log(
        chalk.green(
          `✔ Stashed on '${result.branch}' (${result.sha.slice(0, 7)})`,
        ),
      );
      console.log(chalk.dim(`  ↳ message: ${result.message}`));
      console.log(
        chalk.dim(
          `  ↳ run 'dub stash pop' on '${result.branch}' to restore, or 'dub stash pop --on <branch>' to move it.`,
        ),
      );
    },
  );

stashCommand.addCommand(
  new Command('pop')
    .description('Pop the most recent dub stash (refuses if branch differs)')
    .option('--on <branch>', 'Checkout <branch> first, then pop the stash')
    .option(
      '--force',
      "Pop onto the current branch even if it doesn't match the recorded branch",
    )
    .option(
      '--dry-run',
      'Print the planned pop without checking out or applying',
    )
    .option('--json', 'Pair with --dry-run to emit the plan as JSON')
    .addHelpText(
      'after',
      `
Examples:
  $ dub stash pop                            Pop most recent (same branch only)
  $ dub stash pop --on feat/other            Checkout feat/other, then pop
  $ dub stash pop --force                    Pop onto current branch regardless
  $ dub stash pop --dry-run                  Preview the plan without mutating

See also:
  dub stash, dub stash list`,
    )
    .action(
      async (options: {
        on?: string;
        force?: boolean;
        dryRun?: boolean;
        json?: boolean;
      }) => {
        const result = await stashPop(process.cwd(), {
          on: options.on,
          force: options.force,
          dryRun: options.dryRun,
        });
        if (result.dryRun) {
          if (options.json) {
            emitDryRunPlan(result);
            return;
          }
          console.log(
            chalk.green(
              `✔ Dry-run: would pop stash ${result.sha.slice(0, 7)} on '${result.branch}'`,
            ),
          );
          return;
        }
        if (result.checkedOut) {
          console.log(chalk.green(`✔ Switched to '${result.branch}'`));
        }
        const label =
          result.sourceBranch === result.branch
            ? `'${result.branch}'`
            : `'${result.branch}' (originally on '${result.sourceBranch}')`;
        console.log(chalk.green(`✔ Popped stash on ${label}`));
        console.log(chalk.dim(`  ↳ message: ${result.message}`));
      },
    ),
);

stashCommand.addCommand(
  new Command('list')
    .description('Show recorded dub stashes with branch context')
    .addHelpText(
      'after',
      `
Examples:
  $ dub stash list    Show recorded dub stashes with branch context

See also:
  dub stash, dub stash pop`,
    )
    .action(runStashList),
);

async function runStashList(): Promise<void> {
  const result = await stashList(process.cwd());
  if (result.entries.length === 0) {
    console.log(chalk.dim('No dub stash entries recorded.'));
    return;
  }
  for (let i = 0; i < result.entries.length; i += 1) {
    const entry = result.entries[i];
    const prefix = `${i}:`;
    const refLabel = entry.ref ?? '(dropped)';
    const presence = entry.present ? chalk.green('●') : chalk.yellow('○');
    console.log(
      `${presence} ${chalk.bold(prefix)} ${chalk.cyan(entry.branch)}  ${chalk.dim(refLabel)}  ${chalk.dim(entry.createdAt)}`,
    );
    console.log(chalk.dim(`    ↳ ${entry.message}`));
  }
}

async function runSubmit(options: {
  dryRun?: boolean;
  ai?: boolean;
  noAi?: boolean;
  draft?: boolean;
  publish?: boolean;
  path?: SubmitPathMode;
  upstack?: boolean;
  downstack?: boolean;
  stack?: boolean;
  branch?: string;
  fix?: boolean;
  mergeWhenReady?: boolean;
  method?: 'merge' | 'squash' | 'rebase';
  reviewers?: string | false;
  web?: boolean;
  rerequestReview?: boolean;
  rerequestReviewOnly?: string[];
}) {
  const result = await submit(process.cwd(), options.dryRun ?? false, {
    ai: options.ai,
    noAi: options.noAi,
    draft: options.draft,
    publish: options.publish,
    path: options.path,
    upstack: options.upstack,
    downstack: options.downstack,
    stack: options.stack,
    branch: options.branch,
    fix: options.fix ?? false,
    mergeWhenReady: options.mergeWhenReady,
    method: options.method,
    reviewers:
      typeof options.reviewers === 'string' ? options.reviewers : undefined,
    noReviewers: options.reviewers === false,
    web: options.web,
    rerequestReview: options.rerequestReview,
    rerequestReviewOnly: options.rerequestReviewOnly,
  });

  if (result.pushed.length > 0 && result.dryRun) {
    const prAction = options.web ? 'check/open' : 'check/create';
    console.log(
      chalk.green(
        `✔ Dry-run complete (${describeScopeLabel(result.scope)}): would push ${result.pushed.length} branch(es) and ${prAction} ${result.pushed.length} PR(s).`,
      ),
    );
    return;
  }

  if (result.pushed.length > 0) {
    console.log(
      chalk.green(
        `✔ Pushed ${result.pushed.length} branch(es), created ${result.created.length} PR(s), updated ${result.updated.length} PR(s), opened ${result.webOpened.length} PR form(s)`,
      ),
    );
    if (result.published.length > 0) {
      console.log(
        chalk.green(
          `✔ Published ${result.published.length} draft PR(s) as ready for review`,
        ),
      );
    }
    for (const branch of [
      ...result.created,
      ...result.updated,
      ...result.webOpened,
    ]) {
      console.log(chalk.dim(`  ↳ ${branch}`));
    }
    if (result.autoMergeEnabled.length > 0) {
      console.log(
        chalk.green(
          `✔ Queued auto-merge for ${result.autoMergeEnabled.length} PR(s)`,
        ),
      );
      for (const branch of result.autoMergeEnabled) {
        console.log(chalk.dim(`  ↳ ${branch}`));
      }
    }
    if (result.autoMergeSkipped.length > 0) {
      console.log(
        chalk.dim(
          `  ↳ Auto-merge already queued for ${result.autoMergeSkipped.length} PR(s)`,
        ),
      );
    }
    const reviewRerequests = result.reviewRerequests.filter(
      (entry) => entry.reviewers.length > 0,
    );
    if (reviewRerequests.length > 0) {
      console.log(
        chalk.green(
          `✔ Re-requested review on ${reviewRerequests.length} PR(s)`,
        ),
      );
      for (const entry of reviewRerequests) {
        console.log(
          chalk.dim(
            `  ↳ ${entry.branch} (#${entry.prNumber}): ${entry.reviewers.join(', ')}`,
          ),
        );
      }
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

async function runSplit(options: {
  byCommit?: boolean;
  byFile?: string[];
  byHunk?: boolean;
  ai?: boolean;
  name?: string;
  commitPicks?: string;
  closeOldPr?: boolean;
  restack?: boolean;
  dryRun?: boolean;
  json?: boolean;
  yes?: boolean;
  interactive?: boolean;
}) {
  const selectedModes: SplitMode[] = [];
  if (options.byCommit) selectedModes.push('by-commit');
  if (options.byFile && options.byFile.length > 0)
    selectedModes.push('by-file');
  if (options.byHunk) selectedModes.push('by-hunk');
  if (options.ai) selectedModes.push('ai');

  if (selectedModes.length === 0) {
    throw new DubError(
      "Pick a split mode: '--by-commit', '--by-file <files...>', '--by-hunk', or '--ai'.",
      [
        "Run 'dub split --by-file <files...> --name <new-branch>' to extract files.",
        "Run 'dub split --by-commit' for an interactive commit picker.",
      ],
    );
  }
  if (selectedModes.length > 1) {
    throw new DubError(
      "Split modes are mutually exclusive; pick one of '--by-commit', '--by-file', '--by-hunk', or '--ai'.",
      ["Rerun 'dub split <mode>' with exactly one mode flag."],
    );
  }

  const mode = selectedModes[0];
  // Pass the raw string straight through; split() parses + validates it
  // against the real commit count so error messages are meaningful.
  const result = await split(process.cwd(), {
    mode,
    files: options.byFile,
    name: options.name,
    commitPicksRaw: options.commitPicks,
    closeOldPr: options.closeOldPr,
    noRestack: options.restack === false,
    dryRun: options.dryRun,
    yes: options.yes,
    interactive: options.interactive,
  });

  if (result.dryRun) {
    if (options.json) {
      emitDryRunPlan(result);
      return;
    }
    if (mode === 'ai') {
      console.log(
        chalk.green(
          `✔ Dry-run: would propose an AI split of '${result.sourceBranch}' against '${result.parentBranch}'.`,
        ),
      );
      console.log(
        chalk.dim(
          "  ↳ AI call skipped to avoid billing. Re-run without --dry-run to see the model's proposed slices.",
        ),
      );
      return;
    }
    console.log(
      chalk.green(
        `✔ Dry-run: would split '${result.sourceBranch}' into ${result.plannedBranches?.length ?? 0} new branch(es).`,
      ),
    );
    return;
  }

  const sliceLabel = result.created.length === 1 ? 'slice' : 'slices';
  console.log(
    chalk.green(
      `✔ Split '${result.sourceBranch}' into ${result.created.length} new ${sliceLabel}:`,
    ),
  );
  for (const c of result.created) {
    console.log(chalk.dim(`  ↳ ${c.branch} (on '${c.parent}')`));
  }
  if (result.sourceEmpty) {
    console.log(
      chalk.yellow(
        `⚠ '${result.sourceBranch}' has no unique commits left vs '${result.parentBranch}'.`,
      ),
    );
  }
  if (result.existingPrNumber != null) {
    if (result.prClosed) {
      console.log(
        chalk.dim(
          `  ↳ Closed existing PR #${result.existingPrNumber} on '${result.sourceBranch}'.`,
        ),
      );
    } else {
      console.log(
        chalk.dim(
          `  ↳ PR #${result.existingPrNumber} on '${result.sourceBranch}' left intact; next 'dub submit' will force-push the new shape.`,
        ),
      );
    }
  }
  if (result.restacked) {
    console.log(chalk.dim('  ↳ Restacked descendants.'));
  }
  console.log(
    chalk.dim(
      "  Run 'dub submit' to push the new branches and create their PRs.",
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
    activateJsonMode();
    console.log(
      JSON.stringify(
        withSchemaVersion(await logJson(cwd, logOptions)),
        null,
        2,
      ),
    );
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

function parseBackSteps(positional?: string): number {
  if (!positional) return 1;
  const parsed = Number(positional);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new DubError('Back steps must be a positive integer.', [
      "Pass a positive integer, for example 'dub back 2'.",
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

function printFreezeResult(
  result: {
    changed: string[];
    unchanged: string[];
    skipped: Array<{ branch: string; worktree: string }>;
  },
  pastTense: 'frozen' | 'unfrozen',
): void {
  if (result.changed.length === 0) {
    if (result.unchanged.length === 0 && result.skipped.length === 0) {
      console.log(chalk.yellow('⚠ No tracked branches were updated.'));
      return;
    }
    if (result.unchanged.length > 0) {
      console.log(
        chalk.yellow(`⚠ Already ${pastTense}: ${result.unchanged.join(', ')}`),
      );
    } else {
      console.log(
        chalk.yellow(
          '⚠ No tracked branches were updated — every target was checked out in another worktree.',
        ),
      );
    }
  } else {
    console.log(
      chalk.green(
        `✔ ${capitalize(pastTense)} ${result.changed.length} branch(es): ${result.changed.join(', ')}`,
      ),
    );
    if (result.unchanged.length > 0) {
      console.log(
        chalk.dim(`  ↳ already ${pastTense}: ${result.unchanged.join(', ')}`),
      );
    }
  }
  if (result.skipped.length > 0) {
    const skippedNames = result.skipped.map((s) => s.branch).join(', ');
    console.log(
      chalk.dim(
        `  ↳ skipped (checked out in another worktree): ${skippedNames}`,
      ),
    );
  }
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
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

function printReadyAiReview(
  aiReview: ReadyAiReviewResult | null,
  verbose: boolean,
): void {
  if (!aiReview) return;

  const issueCount = aiReview.branches.reduce(
    (sum, branch) => sum + branch.issues.length,
    0,
  );
  if (issueCount === 0) {
    console.log(chalk.green('✔ AI review found no readiness issues.'));
    return;
  }

  if (aiReview.skipped) {
    console.log(
      chalk.yellow('⚠ AI review gate bypassed with --ai-skip-review.'),
    );
  }

  for (const branch of aiReview.branches) {
    if (branch.issues.length === 0) {
      console.log(chalk.green(`✔ AI review (${branch.branch}): no issues.`));
      continue;
    }

    const visibleIssues = verbose ? branch.issues : branch.issues.slice(0, 3);
    console.log(chalk.yellow(`AI review (${branch.branch}):`));
    for (const issue of visibleIssues) {
      console.log(chalk.yellow(`  - [${issue.severity}] ${issue.message}`));
      console.log(chalk.dim(`    Action: ${issue.action}`));
    }
    if (!verbose && branch.issues.length > visibleIssues.length) {
      console.log(
        chalk.dim(
          `    ${branch.issues.length - visibleIssues.length} more issue(s); rerun with --ai --verbose to show all.`,
        ),
      );
    }
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

function parseReviewerList(value: string): string[] {
  const reviewers = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (reviewers.length === 0) {
    throw new DubError('Reviewer list cannot be empty.', [
      "Pass a comma-separated list, for example '--rerequest-review-only monalisa,hubot'.",
    ]);
  }
  return reviewers;
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
let invocationStateLock: StateLockHandle | null = null;

program.hook('preAction', async (_thisCommand, actionCommand) => {
  setVerbose(Boolean(program.opts().verbose));
  beginHistoryCapture();
  if (shouldAcquireInvocationStateLock()) {
    invocationStateLock = await acquireStateLock(process.cwd(), {
      commandName: `dub ${(historyArgsForCapture ?? process.argv.slice(2)).join(' ')}`,
    });
  }

  // For `--dry-run --json` we must flip the top-level error handler to JSON
  // envelopes BEFORE the action runs — otherwise a DubError thrown during
  // validation (before `emitDryRunPlan` would fire) leaks human-formatted
  // red text and breaks scripted JSON parsers.
  const actionOpts = actionCommand.opts();
  maybeActivateDryRunJsonMode({
    dryRun: Boolean(actionOpts.dryRun),
    json: Boolean(actionOpts.json),
  });

  const isRestoreFromRefs =
    actionCommand.name() === 'init' &&
    Boolean(actionCommand.opts().restoreFromRefs);
  if (isRestoreFromRefs) return;
  await migrateStateRefsIfNeeded(process.cwd());
});

program.hook('postAction', async () => {
  await finalizeHistoryCapture('success');
  await releaseInvocationStateLock();
});

async function main() {
  // `dub completion bash | source /dev/stdin`, `dub man | head -1`, and
  // similar pipelines close stdout before we finish writing. Without this
  // listener Node 22 surfaces EPIPE as an unhandled error and exits 1.
  // Treat a closed stdout as a normal early-exit signal.
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') process.exit(0);
  });

  try {
    const rawArgs = process.argv.slice(2);
    historyArgsForCapture = rawArgs;
    const knownCommands = collectKnownTopLevelCommands(program.commands);
    const config = await readConfig(process.cwd()).catch(() => null);
    const noColor =
      rawArgs.includes('--no-color') || process.env.NO_COLOR != null;
    const resolvedTheme = resolveTheme(config?.theme ?? 'auto', { noColor });
    applyTheme(resolvedTheme);
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
      if (jsonOutputActive) {
        emitJsonError(error);
      } else {
        const [firstLine, ...rest] = formatDubError(error).split('\n');
        console.error(chalk.red(`✖ ${firstLine}`));
        for (const line of rest) {
          console.error(line);
        }
      }
      await finalizeHistoryCapture('error', error.message);
      await releaseInvocationStateLock();
      process.exit(1);
    }

    if (jsonOutputActive) {
      // Surface unexpected exceptions as a parseable envelope so
      // `--json` consumers never see a raw Node stack trace on stdout.
      console.log(
        JSON.stringify(
          jsonErrorEnvelope(
            error instanceof Error ? error.message : 'Unknown error',
          ),
          null,
          2,
        ),
      );
    }
    await finalizeHistoryCapture(
      'error',
      error instanceof Error ? error.message : 'Unknown error',
    );
    await releaseInvocationStateLock();
    throw error;
  }
}

const STATE_MUTATING_COMMANDS = new Set([
  'abort',
  'absorb',
  'ai-setup',
  'back',
  'bottom',
  'config',
  'continue',
  'checkout',
  'co',
  'create',
  'delete',
  'down',
  'f',
  'flow',
  'fold',
  'freeze',
  'init',
  'land',
  'merge-next',
  'm',
  'modify',
  'move',
  'pop',
  'post-merge',
  'prune',
  'rename',
  'reorder',
  'restack',
  'revert',
  'split',
  'squash',
  'ss',
  'stash',
  'submit',
  'sync',
  'top',
  'track',
  'undo',
  'unfreeze',
  'unlink',
  'untrack',
  'up',
]);

function shouldAcquireInvocationStateLock(): boolean {
  const args = historyArgsForCapture ?? process.argv.slice(2);
  const command = firstCommandArg(args);
  if (!command) return false;
  // Keep the documented read-only/MCP bypasses explicit so future alias changes
  // do not accidentally start locking commands that must remain non-blocking.
  if (command === 'log') return false;
  if (command === 'status' && args.includes('--json')) return false;
  if (command === 'doctor' && args.includes('--no-fetch')) return false;
  if (command === 'mcp') return false;
  return STATE_MUTATING_COMMANDS.has(command);
}

function firstCommandArg(args: string[]): string | null {
  for (const arg of args) {
    if (!arg.startsWith('-')) return arg;
  }
  return null;
}

async function releaseInvocationStateLock(): Promise<void> {
  if (!invocationStateLock) return;
  const lock = invocationStateLock;
  invocationStateLock = null;
  await lock.release();
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

export { program };

// Only auto-run when this file is the entrypoint — when vitest (or any other
// harness) imports it for introspection we leave the program constructed but
// dormant. Compare via `realpathSync` so the published bin works: pnpm/npm
// installs `node_modules/.bin/dub` as a symlink to `dubstack/dist/index.js`,
// and `import.meta.url` always resolves through the symlink.
function isCliEntrypoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isCliEntrypoint()) {
  main();
}
