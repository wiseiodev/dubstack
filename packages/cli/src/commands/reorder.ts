import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import select from '@inquirer/select';
import chalk from 'chalk';
import { DubError } from '../lib/errors';
import { execa } from '../lib/exec';
import {
  getBranchTip,
  getCurrentBranch,
  getMergeBase,
  isWorkingTreeClean,
} from '../lib/git';
import {
  buildRebaseTodo,
  isNoopReorder,
  type RebaseTodoEntry,
} from '../lib/rebase-todo';
import {
  resolveRestackConflictDecision,
  restackConflictPrompt,
} from '../lib/restack-conflict-prompt';
import { rollbackRestack } from '../lib/restack-rollback';
import { findStackForBranch, getParent, readState } from '../lib/state';
import { saveUndoEntry } from '../lib/undo-log';
import { assertBranchesNotCheckedOutElsewhere } from '../lib/worktree-guards';
import { restack } from './restack';

/**
 * Options accepted by {@link reorder}.
 */
export interface ReorderOptions {
  /**
   * Skip the interactive picker and apply the supplied entries directly.
   * Test-only — production callers always go through the TUI picker. Order
   * is oldest-first to match the on-disk rebase todo.
   */
  entries?: RebaseTodoEntry[];
  /**
   * Override the default `@inquirer/select`-based action prompt. Wired by
   * tests so we don't need a real TTY.
   */
  promptAction?: ActionPrompt;
  /**
   * Override the default `restackConflictPrompt`. Wired by tests so the
   * conflict-path branches are covered without a TTY.
   */
  promptConflict?: (branch: string) => Promise<'continue' | 'cancel' | 'exit'>;
  /** Preview the reorderable commits without launching the picker. */
  dryRun?: boolean;
}

/**
 * Outcome returned by {@link reorder}. The shape mirrors `RestackResult` so
 * the CLI wrapper can render conflict/no-op/success messages with the same
 * dispatch shape it uses for `dub restack` and `dub move`.
 */
export interface ReorderResult {
  status: 'success' | 'conflict' | 'cancelled' | 'no-op' | 'exit' | 'dry-run';
  /** Commits in the new order (oldest-first), excluding dropped commits. */
  finalPicks: string[];
  /** Commits the user marked as `drop`. */
  dropped: string[];
  /** Branches rebased by the cascading restack. */
  rebased: string[];
  /** Set when the cascading restack hit a conflict. */
  conflictBranch?: string;
  /** True when invoked with `--dry-run`; no mutations were performed. */
  dryRun: boolean;
  /** Reorderable commits (oldest-first) returned by `--dry-run`. */
  reorderableCommits?: string[];
  /**
   * Discriminates between the reorder rebase itself producing a conflict
   * (`'reorder'`) and the cascading descendant restack producing one
   * (`'restack'`). The CLI wrapper uses this to print the right recovery
   * hint — `dub continue` resumes a cascading restack, but the reorder
   * rebase has no restack-progress.json, so users must `git rebase --continue`
   * then `dub restack` manually.
   */
  conflictSource?: 'reorder' | 'restack';
  /** Set on no-op / cancellation paths to explain why nothing was rewritten. */
  noOpReason?: string;
}

interface CommitInfo {
  sha: string;
  shortSha: string;
  subject: string;
}

interface PickerEntry {
  commit: CommitInfo;
  action: 'pick' | 'drop';
}

export interface ActionPromptInput {
  /** Current order (newest first), with each entry's oldest-first `todoIndex`. */
  entries: ReadonlyArray<{
    commit: CommitInfo;
    action: 'pick' | 'drop';
    todoIndex: number;
  }>;
}

export type ActionPromptResult =
  | { kind: 'done' }
  | { kind: 'cancel' }
  | { kind: 'noop' }
  | { kind: 'move'; todoIndex: number; direction: 'up' | 'down' }
  | { kind: 'toggle-drop'; todoIndex: number };

type ActionPrompt = (input: ActionPromptInput) => Promise<ActionPromptResult>;

const COMMIT_FIELD_SEP = '\x1f';
// Sentinel attached to the DubError thrown by `runInteractiveRebaseWithTodo`
// so the conflict-prompt dispatch matches on a stable discriminator instead
// of substring-scanning the user-facing message.
const REORDER_CONFLICT_KIND = 'reorder-conflict';

function isReorderConflictError(error: unknown): error is DubError {
  return (
    error instanceof DubError &&
    (error as DubError & { kind?: string }).kind === REORDER_CONFLICT_KIND
  );
}

/**
 * Reorders commits within the current branch via an interactive picker.
 *
 * Scope is deliberately narrow: the picker only supports moving commits and
 * marking them as `drop`. Editing, squashing, and rewording are handled by
 * `dub modify --pop` and (future) `dub squash`.
 *
 * Workflow:
 * 1. Validate working tree is clean and current branch is tracked.
 * 2. List commits between the parent branch and HEAD.
 * 3. Open the picker; the user moves commits and toggles drops.
 * 4. If the picker exits without changes, return a no-op (nothing rewritten).
 * 5. Otherwise build a custom rebase todo and run `git rebase -i` with
 *    `GIT_SEQUENCE_EDITOR` overriding the todo file.
 * 6. On rebase conflict, prompt with the shared `restackConflictPrompt`
 *    (matching `dub restack`) — continue/cancel/exit semantics included.
 * 7. After a clean rebase, restack descendants so they replay onto the new tip.
 * 8. Save a `reorder` undo entry so `dub undo` rolls back to the pre-reorder
 *    branch tips.
 *
 * @throws {DubError} If not on a tracked non-root branch, working tree dirty,
 * branch has no commits since parent, or rebase fails outside the conflict
 * path.
 */
export async function reorder(
  cwd: string,
  options: ReorderOptions = {},
): Promise<ReorderResult> {
  if (!(await isWorkingTreeClean(cwd))) {
    throw new DubError('Working tree has uncommitted changes.', [
      "Run 'git status' to see the uncommitted changes.",
      "Run 'git stash' to set the changes aside, then rerun 'dub reorder'.",
      'Run \'dub modify -am "<message>"\' to commit the changes first.',
    ]);
  }

  const state = await readState(cwd);
  const currentBranch = await getCurrentBranch(cwd);
  const stack = findStackForBranch(state, currentBranch);
  if (!stack) {
    throw new DubError(`Branch '${currentBranch}' is not tracked.`, [
      `Run 'dub track ${currentBranch} --parent <branch>' to track it first.`,
      "Run 'dub log' to inspect tracked stacks.",
    ]);
  }

  const branchEntry = stack.branches.find((b) => b.name === currentBranch);
  if (branchEntry?.type === 'root') {
    throw new DubError(
      `Cannot reorder commits on root branch '${currentBranch}'.`,
      ["Run 'dub checkout' to switch to a non-root branch in the stack."],
    );
  }

  const dryRun = options.dryRun ?? false;
  if (!dryRun) {
    await assertBranchesNotCheckedOutElsewhere(
      cwd,
      [currentBranch],
      'dub reorder',
    );
  }

  const parent = getParent(state, currentBranch);
  if (!parent) {
    throw new DubError(
      `Could not determine parent branch for '${currentBranch}'.`,
      [
        `Run 'dub track ${currentBranch} --parent <branch>' to set the parent.`,
        "Run 'dub log' to inspect the stack and confirm tracking state.",
      ],
    );
  }

  const base = await getMergeBase(parent, currentBranch, cwd);
  const commits = await listCommitsBetween(base, currentBranch, cwd);

  if (commits.length === 0) {
    throw new DubError(
      `Branch '${currentBranch}' has no commits beyond '${parent}'.`,
      [
        `Run 'dub modify -ac -m "<message>"' to add a commit, then retry.`,
        "Run 'dub log' to confirm the branch has commits to reorder.",
      ],
    );
  }

  if (commits.length === 1) {
    // A single commit has nothing to reorder, and dropping it would empty
    // the branch — explicitly out of scope (use `dub modify` instead).
    throw new DubError(
      `Branch '${currentBranch}' has only one commit; nothing to reorder.`,
      [
        "Add more commits before reordering, or run 'dub modify --pop' to edit the existing commit.",
      ],
    );
  }

  if (dryRun) {
    const reorderableCommits = commits
      .slice()
      .reverse()
      .map((c) => c.sha);
    return {
      status: 'dry-run',
      finalPicks: reorderableCommits,
      dropped: [],
      rebased: [],
      noOpReason: `Would launch picker for ${commits.length} commit(s) on '${currentBranch}'.`,
      dryRun: true,
      reorderableCommits,
    };
  }

  const pickerResult = options.entries
    ? {
        kind: 'done' as const,
        entries: validateProvidedEntries(options.entries, commits),
      }
    : await runPicker(commits, options.promptAction);

  if (pickerResult.kind === 'cancel') {
    return {
      status: 'cancelled',
      finalPicks: [],
      dropped: [],
      rebased: [],
      noOpReason: 'Cancelled in picker',
      dryRun: false,
    };
  }

  // `commits` is newest-first (git log order). The rebase todo (and
  // `pickerResult.entries`) is oldest-first. Reverse here so the no-op
  // comparison is apples-to-apples.
  const originalShasOldestFirst = commits
    .slice()
    .reverse()
    .map((c) => c.sha);
  if (isNoopReorder(originalShasOldestFirst, pickerResult.entries)) {
    return {
      status: 'no-op',
      finalPicks: originalShasOldestFirst,
      dropped: [],
      rebased: [],
      noOpReason: 'No reorder or drop changes were made in the picker',
      dryRun: false,
    };
  }

  // Snapshot every tracked branch tip BEFORE rewriting history so undo can
  // restore both the reordered branch and any descendants the cascading
  // restack rewrites.
  const branchTips: Record<string, string> = {};
  for (const otherStack of state.stacks) {
    for (const entry of otherStack.branches) {
      if (entry.name in branchTips) continue;
      branchTips[entry.name] = await getBranchTip(entry.name, cwd);
    }
  }

  await saveUndoEntry(
    {
      operation: 'reorder',
      timestamp: new Date().toISOString(),
      previousBranch: currentBranch,
      previousState: structuredClone(state),
      branchTips,
      createdBranches: [],
    },
    cwd,
  );

  const todoBody = buildRebaseTodo(pickerResult.entries);

  try {
    await runInteractiveRebaseWithTodo(base, todoBody, cwd);
  } catch (error) {
    if (isReorderConflictError(error)) {
      const promptConflict = options.promptConflict ?? defaultConflictPrompt;
      const decision = await promptConflict(currentBranch);
      if (decision === 'cancel') {
        await rollbackRestack(cwd);
        return {
          status: 'cancelled',
          finalPicks: [],
          dropped: [],
          rebased: [],
          noOpReason:
            'Cancelled mid-conflict; rolled back to pre-reorder state',
          dryRun: false,
        };
      }
      if (decision === 'exit') {
        return {
          status: 'exit',
          finalPicks: [],
          dropped: [],
          rebased: [],
          conflictBranch: currentBranch,
          conflictSource: 'reorder',
          dryRun: false,
        };
      }
      // 'continue' — user resolves manually then runs `git rebase --continue`
      // (no `restack-progress.json` exists yet because the conflict was in the
      // reorder rebase, not the cascading restack — see the CLI wrapper for
      // the source-aware recovery hint).
      return {
        status: 'conflict',
        finalPicks: [],
        dropped: [],
        rebased: [],
        conflictBranch: currentBranch,
        conflictSource: 'reorder',
        dryRun: false,
      };
    }
    throw error;
  }

  const finalPicks = pickerResult.entries
    .filter((e) => e.action === 'pick')
    .map((e) => e.sha);
  const dropped = pickerResult.entries
    .filter((e) => e.action === 'drop')
    .map((e) => e.sha);

  // Cascading restack — if it throws (e.g. post-rewrite hook left files
  // staged), the reorder itself is already on disk; surface a hint pointing
  // at `dub undo` so the user can roll back without losing the snapshot.
  let restackResult: Awaited<ReturnType<typeof restack>>;
  try {
    restackResult = await restack(cwd, { skipUndoEntry: true });
  } catch (error) {
    if (error instanceof DubError) {
      throw new DubError(
        `Reorder succeeded but the cascading restack failed: ${error.message}`,
        [
          ...error.recovery,
          "Run 'dub undo' to roll the reorder back to the pre-reorder branch tips.",
          "Run 'dub restack' once the underlying issue is resolved to finish updating descendants.",
        ],
      );
    }
    throw error;
  }

  return {
    status: restackResult.status === 'conflict' ? 'conflict' : 'success',
    finalPicks,
    dropped,
    rebased: restackResult.rebased,
    ...(restackResult.status === 'conflict'
      ? {
          conflictBranch: restackResult.conflictBranch,
          conflictSource: 'restack' as const,
        }
      : {}),
    dryRun: false,
  };
}

/**
 * Validates an `entries` array supplied via `ReorderOptions` (tests + MCP)
 * against the commits actually on the branch. Catches the failure mode
 * where the caller supplies a partial todo (e.g. only 2 of 5 commits) —
 * git would otherwise silently drop the missing commits from history.
 *
 * Returns the validated array. Throws a `DubError` with recovery hints on
 * any mismatch.
 */
function validateProvidedEntries(
  entries: readonly RebaseTodoEntry[],
  commits: readonly CommitInfo[],
): RebaseTodoEntry[] {
  const validShas = new Set(commits.map((c) => c.sha));
  if (entries.length !== commits.length) {
    throw new DubError(
      `Supplied 'entries' has ${entries.length} item(s) but the branch has ${commits.length} commit(s) beyond its parent.`,
      [
        'Pass exactly one entry per commit between the parent and HEAD.',
        "Mark commits you want to remove with action: 'drop' instead of omitting them.",
      ],
    );
  }
  const seen = new Set<string>();
  for (const [idx, entry] of entries.entries()) {
    if (!validShas.has(entry.sha)) {
      throw new DubError(
        `'entries[${idx}]' references SHA '${entry.sha}' which is not on the current branch.`,
        [
          'Run `git log --format=%H <parent>..HEAD` to list the candidate SHAs.',
          'Make sure every entry uses a full SHA from that list.',
        ],
      );
    }
    if (seen.has(entry.sha)) {
      throw new DubError(
        `'entries' lists SHA '${entry.sha}' more than once. Each commit may appear only once.`,
        [
          'Remove the duplicate; mark commits you want to skip with `action: "drop"` instead of repeating them.',
        ],
      );
    }
    seen.add(entry.sha);
  }
  if (entries.every((e) => e.action === 'drop')) {
    throw new DubError(
      "Supplied 'entries' marks every commit as 'drop'; the rebase would leave the branch empty.",
      [
        "Keep at least one commit as 'pick' (use 'dub delete' if you really want to remove the branch).",
      ],
    );
  }
  return entries as RebaseTodoEntry[];
}

async function defaultConflictPrompt(
  branch: string,
): Promise<'continue' | 'cancel' | 'exit'> {
  // Match `dub restack`: in non-TTY contexts (CI, MCP, piped stdin), skip the
  // prompt and default to `continue` so the existing "resolve + run dub
  // continue" recovery still works.
  const interactive = Boolean(process.stdout.isTTY && process.stdin.isTTY);
  const decision = await resolveRestackConflictDecision({
    branch,
    interactive,
    promptChoice: (branchName) => restackConflictPrompt({ branch: branchName }),
  });
  if (decision === 'ai') {
    throw new DubError('AI conflict resolution is not supported by reorder.', [
      'Resolve the conflict manually, then continue the operation.',
    ]);
  }
  return decision;
}

/**
 * Returns commits between `base` (exclusive) and `headRef` (inclusive),
 * ordered newest-first to match `git log`. The on-disk rebase todo reverses
 * this to oldest-first when the picker exits.
 */
async function listCommitsBetween(
  base: string,
  headRef: string,
  cwd: string,
): Promise<CommitInfo[]> {
  let stdout: string;
  try {
    const result = await execa(
      'git',
      [
        'log',
        `--format=%H${COMMIT_FIELD_SEP}%h${COMMIT_FIELD_SEP}%s`,
        `${base}..${headRef}`,
      ],
      { cwd },
    );
    stdout = result.stdout;
  } catch {
    throw new DubError(
      `Failed to list commits for '${headRef}' since '${base}'.`,
      [
        `Run 'git log ${base}..${headRef}' manually to inspect the underlying error.`,
        "Run 'dub doctor' to check the stack for damage.",
      ],
    );
  }

  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(COMMIT_FIELD_SEP);
      return {
        sha: parts[0] ?? '',
        shortSha: parts[1] ?? '',
        subject: parts[2] ?? '',
      };
    })
    .filter((c) => c.sha.length > 0);
}

interface PickerCompletion {
  kind: 'done';
  entries: RebaseTodoEntry[];
}

interface PickerCancellation {
  kind: 'cancel';
}

/**
 * Drives the interactive picker until the user finishes or cancels. Internal
 * `pickerEntries` are kept newest-first to match the user's mental model;
 * the returned todo entries are oldest-first to match git's rebase format.
 */
async function runPicker(
  commits: readonly CommitInfo[],
  promptAction: ActionPrompt | undefined,
): Promise<PickerCompletion | PickerCancellation> {
  // Newest-first display order; matches `git log`.
  const pickerEntries: PickerEntry[] = commits.map((commit) => ({
    commit,
    action: 'pick',
  }));

  const prompt = promptAction ?? defaultActionPrompt;

  while (true) {
    const input = buildActionPromptInput(pickerEntries);
    const action = await prompt(input);

    if (action.kind === 'done') {
      const entries = pickerEntries
        .slice()
        .reverse() // newest-first display → oldest-first todo
        .map<RebaseTodoEntry>((entry) => ({
          sha: entry.commit.sha,
          action: entry.action,
          subject: entry.commit.subject,
        }));

      if (entries.every((e) => e.action === 'drop')) {
        // Dropping every commit empties the branch and aborts the rebase.
        // Surface a hint and let the user fix the picker.
        console.log(
          chalk.yellow(
            '⚠ All commits marked as drop. Mark at least one as pick before finishing.',
          ),
        );
        continue;
      }
      return { kind: 'done', entries };
    }

    if (action.kind === 'cancel') {
      return { kind: 'cancel' };
    }

    if (action.kind === 'noop') {
      // Prompt returned without a state change (e.g. user pressed (back));
      // re-render the picker and re-prompt without deepening the call stack.
      continue;
    }

    if (action.kind === 'toggle-drop') {
      const displayIndex = todoIndexToDisplayIndex(
        action.todoIndex,
        pickerEntries.length,
      );
      const entry = pickerEntries[displayIndex];
      if (entry) {
        entry.action = entry.action === 'pick' ? 'drop' : 'pick';
      }
      continue;
    }

    if (action.kind === 'move') {
      const displayIndex = todoIndexToDisplayIndex(
        action.todoIndex,
        pickerEntries.length,
      );
      // In the on-disk todo, "up" = earlier (closer to base / older). In the
      // newest-first display, that's a higher numeric display index.
      const swapWith =
        action.direction === 'up' ? displayIndex + 1 : displayIndex - 1;
      if (swapWith < 0 || swapWith >= pickerEntries.length) {
        continue;
      }
      const a = pickerEntries[displayIndex];
      const b = pickerEntries[swapWith];
      if (a && b) {
        pickerEntries[displayIndex] = b;
        pickerEntries[swapWith] = a;
      }
    }
  }
}

function buildActionPromptInput(
  entries: readonly PickerEntry[],
): ActionPromptInput {
  // todoIndex is oldest-first; pickerEntries are newest-first.
  return {
    entries: entries.map((entry, displayIdx) => ({
      commit: entry.commit,
      action: entry.action,
      todoIndex: entries.length - 1 - displayIdx,
    })),
  };
}

function todoIndexToDisplayIndex(todoIndex: number, total: number): number {
  return total - 1 - todoIndex;
}

async function defaultActionPrompt(
  input: ActionPromptInput,
): Promise<ActionPromptResult> {
  try {
    return await runDefaultActionPrompt(input);
  } catch (error) {
    // @inquirer/select throws ExitPromptError on Ctrl+C / SIGINT. Treat
    // that as the same intent as the explicit "Cancel" choice so the
    // picker exits cleanly and `runPicker` rolls back without printing
    // a stack trace.
    if (error instanceof Error && error.name === 'ExitPromptError') {
      return { kind: 'cancel' };
    }
    throw error;
  }
}

async function runDefaultActionPrompt(
  input: ActionPromptInput,
): Promise<ActionPromptResult> {
  printPickerState(input);

  const action = await select<'move' | 'toggle' | 'done' | 'cancel'>({
    message: 'What now?',
    choices: [
      { name: 'Move a commit up or down', value: 'move' },
      { name: 'Toggle drop on a commit', value: 'toggle' },
      { name: 'Finish (apply changes)', value: 'done' },
      { name: 'Cancel (discard changes)', value: 'cancel' },
    ],
  });

  if (action === 'done') return { kind: 'done' };
  if (action === 'cancel') return { kind: 'cancel' };

  const commitChoice = await select<number | 'back'>({
    message:
      action === 'move' ? 'Move which commit?' : 'Toggle drop on which commit?',
    choices: [
      ...input.entries.map((entry) => ({
        name: formatChoiceLine(entry),
        value: entry.todoIndex,
      })),
      { name: '(back)', value: 'back' as const },
    ],
  });
  // Returning 'noop' lets `runPicker` re-render and re-prompt without
  // recursing into `defaultActionPrompt` (which would deepen the call stack
  // on every (back) press).
  if (commitChoice === 'back') {
    return { kind: 'noop' };
  }

  if (action === 'toggle') {
    return { kind: 'toggle-drop', todoIndex: commitChoice };
  }

  const direction = await select<'up' | 'down' | 'back'>({
    message: 'Direction',
    choices: [
      { name: '↑ Move up (closer to base / older)', value: 'up' },
      { name: '↓ Move down (closer to tip / newer)', value: 'down' },
      { name: '(back)', value: 'back' as const },
    ],
  });
  if (direction === 'back') {
    return { kind: 'noop' };
  }
  return { kind: 'move', todoIndex: commitChoice, direction };
}

function printPickerState(input: ActionPromptInput): void {
  console.log('');
  console.log(chalk.dim('Reorder commits (newest first):'));
  for (const entry of input.entries) {
    console.log(`  ${formatChoiceLine(entry)}`);
  }
  console.log('');
}

function formatChoiceLine(entry: ActionPromptInput['entries'][number]): string {
  const tag =
    entry.action === 'drop' ? chalk.red('[drop]') : chalk.green('[pick]');
  return `${tag} ${entry.commit.shortSha} ${entry.commit.subject}`;
}

/**
 * Runs `git rebase -i <base>` with the supplied todo body replacing git's
 * auto-generated todo file. A tiny Node bridge acts as the sequence editor
 * so we don't depend on `cp` or shell-quoting rules — the bridge copies our
 * todo file into the path git passes as its argument.
 */
async function runInteractiveRebaseWithTodo(
  base: string,
  todoBody: string,
  cwd: string,
): Promise<void> {
  const stamp = randomUUID();
  const todoFile = path.join(os.tmpdir(), `dubstack-reorder-todo-${stamp}`);
  // CJS extension required: git spawns this as a standalone Node script via
  // `GIT_SEQUENCE_EDITOR`, with no --input-type=module context. The CLI
  // package itself is ESM, so the bridge has to live in its own .cjs file.
  const bridgeFile = path.join(
    os.tmpdir(),
    `dubstack-reorder-bridge-${stamp}.cjs`,
  );

  // Git invokes `GIT_SEQUENCE_EDITOR` via /bin/sh and appends the
  // auto-generated todo path as the final arg, so the bridge sees the git
  // todo path on `process.argv[2]`. The pre-built todo path travels through
  // an env var to dodge shell-splitting on user paths with spaces (e.g.
  // `process.execPath` under a `/Users/John Doe/…` profile).
  await Promise.all([
    writeFile(todoFile, todoBody),
    writeFile(
      bridgeFile,
      "const fs=require('fs');fs.copyFileSync(process.env.DUBSTACK_REORDER_TODO,process.argv[2]);\n",
    ),
  ]);

  try {
    await execa('git', ['rebase', '-i', base], {
      cwd,
      env: {
        ...process.env,
        // Double-quote each path so spaces in process.execPath / tmpdir do
        // not split into separate argv tokens once git delegates to /bin/sh.
        GIT_SEQUENCE_EDITOR: `${shellQuote(process.execPath)} ${shellQuote(bridgeFile)}`,
        DUBSTACK_REORDER_TODO: todoFile,
        // Suppress the commit-message editor for the pick path.
        GIT_EDITOR: 'true',
      },
    });
  } catch {
    const conflict = new DubError('Conflict while reordering commits.', [
      'Resolve conflicts and stage the resolved files.',
      "Run 'dub continue --ai' to let DubStack try the resolution.",
      "Run 'dub continue' (or 'git rebase --continue') after resolving manually.",
      "Run 'dub abort' to cancel and roll back progress.",
    ]);
    (conflict as DubError & { kind: string }).kind = REORDER_CONFLICT_KIND;
    throw conflict;
  } finally {
    cleanupTempFile(todoFile);
    cleanupTempFile(bridgeFile);
  }
}

/**
 * Wraps a path in double quotes and escapes any embedded `"`/`\``/`$`/`\\`.
 * Targets the POSIX `/bin/sh -c` path that git uses to invoke
 * `GIT_SEQUENCE_EDITOR`; the CLI does not currently target Windows.
 */
function shellQuote(value: string): string {
  return `"${value.replace(/(["`$\\])/g, '\\$1')}"`;
}

function cleanupTempFile(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Best-effort cleanup; tmpdir is reaped by the OS.
  }
}

/**
 * Internal helpers exposed for tests so picker state-transformation logic
 * (move up/down, toggle drop, finalise) can be covered without a real TTY.
 *
 * @internal Not part of the public API surface — do not import outside tests.
 */
export const _testing = {
  buildActionPromptInput,
  todoIndexToDisplayIndex,
};
