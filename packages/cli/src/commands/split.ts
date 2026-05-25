import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { fromIni, fromNodeProviderChain } from '@aws-sdk/credential-providers';
import input from '@inquirer/input';
import { createGateway, generateText } from 'ai';
import { buildAiDiffContext } from '../lib/ai-diff-context';
import type { AiMetadataDependencies } from '../lib/ai-metadata';
import {
  appendCleanupOperation,
  type CleanupJournal,
  clearCleanupJournal,
  hasCleanupJournal,
  startCleanupJournal,
} from '../lib/cleanup-journal';
import { readConfig } from '../lib/config';
import { DubError } from '../lib/errors';
import {
  addPaths,
  branchExists,
  type CommitInfo,
  checkoutBranch,
  checkoutPathsFromRef,
  cherryPick,
  cherryPickAbort,
  commitStaged,
  createBranchFrom,
  getBranchTip,
  getCurrentBranch,
  getDiffBetween,
  getDiffFileNamesBetween,
  hasStagedChanges,
  hasUnstagedTrackedChanges,
  InteractivePatchQuitError,
  interactiveResetPatch,
  isValidBranchName,
  isWorkingTreeClean,
  listCommitsBetween,
  listPathsAtRef,
  removePaths,
  resetHard,
  softResetTo,
  stageAll,
  stashDropTop,
  stashKeepIndex,
  stashPop,
} from '../lib/git';
import { closePr } from '../lib/github';
import {
  type AiSplitProposal,
  generateAiSplitProposal,
  parseIndexSelection,
} from '../lib/split';
import {
  addBranchToStack,
  type Branch,
  findStackForBranch,
  readState,
  writeState,
} from '../lib/state';
import { restack } from './restack';

export type SplitMode = 'by-commit' | 'by-file' | 'by-hunk' | 'ai';

export interface SplitOptions {
  /** Which split mode to run. */
  mode: SplitMode;
  /** For `--by-file`: file paths to extract. */
  files?: string[];
  /** New branch name(s). Required for `--by-file`; optional for interactive modes. */
  name?: string;
  /**
   * For `--by-commit`: 1-indexed commit positions to extract (oldest-first).
   * When supplied, skips the interactive prompt. Useful for scripted runs and tests.
   */
  commitPicks?: number[];
  /**
   * For `--by-commit`: raw string from the CLI (`"1,3-4"` style) to be parsed
   * + validated against the actual commit count. Prefer this over `commitPicks`
   * when wiring from the CLI so the user gets a meaningful out-of-range error.
   */
  commitPicksRaw?: string;
  /** Close any existing PR on the source branch instead of leaving it for `dub submit` to force-push. */
  closeOldPr?: boolean;
  /** Skip the auto-restack after the split completes. */
  noRestack?: boolean;
  /** AI mode only: print the proposal and exit without applying. */
  dryRun?: boolean;
  /** AI mode only: skip the interactive approval prompt. */
  yes?: boolean;
  /** Disable interactive prompts (CI/scripted runs). */
  interactive?: boolean;
}

export interface SplitNewBranchResult {
  branch: string;
  parent: string;
  files?: string[];
  commits?: string[];
}

export interface SplitResult {
  /** The original branch that was split. */
  sourceBranch: string;
  /** The parent of the source branch. */
  parentBranch: string;
  /** New branches created by the split, in creation order. */
  created: SplitNewBranchResult[];
  /** True when the source branch ended up with no unique commits left. */
  sourceEmpty: boolean;
  /** PR number of the source branch (if any was attached when split started). */
  existingPrNumber: number | null;
  /** Whether the existing PR was closed (either via `--close-old-pr` or empty-source fallback). */
  prClosed: boolean;
  /** Whether the descendant restack ran. */
  restacked: boolean;
  /** AI mode only: the proposal returned by the model (filled even on --dry-run). */
  aiProposal?: AiSplitProposal[];
}

type SplitDependencies = AiMetadataDependencies;

const DEFAULT_DEPS: SplitDependencies = {
  generateText,
  createGoogleGenerativeAI,
  createAnthropic,
  createGateway,
  createAmazonBedrock,
  createOpenAI,
  fromIni,
  fromNodeProviderChain,
};

/**
 * Splits the current branch into the source branch plus one or more new
 * sibling branches sharing the same parent.
 *
 * - `--by-commit`: interactive numbered checklist of commits to extract.
 * - `--by-file <files...>`: non-interactive; the listed files move to the new branch.
 * - `--by-hunk`: interactive `git reset --patch` hunk picker.
 * - `--ai`: model proposes a semantic split; user approves before any branch changes.
 *
 * After the split, the existing restack flow runs so descendants follow the
 * source branch's new tip. PRs on the source branch are left intact by default
 * (the next `dub submit` force-pushes the new shape). `--close-old-pr` opts in
 * to Graphite-style "close old + create new". An empty source branch always
 * closes its PR with a comment since GitHub rejects empty PRs.
 */
export async function split(
  cwd: string,
  options: SplitOptions,
  deps: SplitDependencies = DEFAULT_DEPS,
): Promise<SplitResult> {
  if (!(await isWorkingTreeClean(cwd))) {
    throw new DubError('Working tree has uncommitted changes.', [
      "Run 'git status' to see uncommitted changes.",
      "Run 'git stash' to set them aside, then rerun 'dub split'.",
    ]);
  }

  // Refuse to start if an unrelated cleanup journal is on disk — running a
  // new split would clobber it and the prior crash would be unrecoverable.
  // Matches the discipline `startCleanupJournal` enforces internally, but
  // surfaced here with a split-flavored recovery hint.
  if (await hasCleanupJournal(cwd)) {
    throw new DubError(
      'A pending DubStack cleanup operation must finish before starting a split.',
      [
        "Run 'dub continue' to finish replaying the interrupted operation.",
        "Run 'dub abort' to discard the pending operation and start fresh.",
      ],
    );
  }

  const state = await readState(cwd);
  const sourceBranch = await getCurrentBranch(cwd);
  const stack = findStackForBranch(state, sourceBranch);
  if (!stack) {
    throw new DubError(`Branch '${sourceBranch}' is not tracked by DubStack.`, [
      `Run 'dub track ${sourceBranch} --parent <parent>' to track it first.`,
      "Run 'dub log' to see tracked branches.",
    ]);
  }
  const sourceMeta = stack.branches.find((b) => b.name === sourceBranch);
  if (!sourceMeta || sourceMeta.type === 'root' || !sourceMeta.parent) {
    throw new DubError(`Cannot split root branch '${sourceBranch}'.`, [
      "Run 'dub checkout <child>' and rerun 'dub split' from a child branch.",
    ]);
  }
  const parentBranch = sourceMeta.parent;
  const parentTip = await getBranchTip(parentBranch, cwd);
  const sourceTipBefore = await getBranchTip(sourceBranch, cwd);
  const existingPrNumber = sourceMeta.pr_number ?? null;

  const created: SplitNewBranchResult[] = [];
  let aiProposal: AiSplitProposal[] | undefined;
  // Lazy-started: only spin up a journal once we're about to mutate git.
  // The AI dry-run path bails before any mutation, so it deliberately
  // skips journal start.
  let journal: CleanupJournal | null = null;
  const startJournal = async () => {
    if (journal === null) journal = await startCleanupJournal(cwd);
    return journal;
  };

  if (options.mode === 'ai') {
    const config = await readConfig(cwd);
    if (!config.aiAssistantEnabled) {
      throw new DubError('AI assistant is disabled for this repo.', [
        "Run 'dub config ai-assistant on' to enable AI for this repo.",
        "Rerun 'dub split --by-file <files...>' or '--by-commit' to drive the split manually.",
      ]);
    }
    aiProposal = await proposeAiSplit({
      cwd,
      sourceBranch,
      parentBranch,
      parentTip,
      sourceTip: sourceTipBefore,
      deps,
      providerConfig: config.ai.provider,
    });
    if (options.dryRun) {
      return {
        sourceBranch,
        parentBranch,
        created: [],
        sourceEmpty: false,
        existingPrNumber,
        prClosed: false,
        restacked: false,
        aiProposal,
      };
    }
    if (!options.yes && options.interactive !== false) {
      await confirmAiProposal(aiProposal);
    }
    // Reject duplicate branch names within the proposal upfront — otherwise
    // the first one would apply, leaving partial state when the second
    // createBranchFrom fails on the collision.
    const seenProposalBranches = new Set<string>();
    for (const proposal of aiProposal) {
      if (seenProposalBranches.has(proposal.branch)) {
        throw new DubError(
          `AI proposed the same branch name '${proposal.branch}' more than once.`,
          [
            "Rerun 'dub split --ai' to regenerate a unique proposal.",
            "Run 'dub split --by-file <files...>' to drive the split manually.",
          ],
        );
      }
      seenProposalBranches.add(proposal.branch);
      await ensureUniqueAvailableBranchName(proposal.branch, cwd);
    }
    const aiJournal = await startJournal();
    for (const proposal of aiProposal) {
      created.push(
        await extractByFiles({
          cwd,
          sourceBranch,
          parentBranch,
          parentTip,
          newBranchName: proposal.branch,
          files: proposal.files,
          summary: proposal.summary,
          journal: aiJournal,
        }),
      );
    }
  } else if (options.mode === 'by-file') {
    if (!options.files || options.files.length === 0) {
      throw new DubError("'--by-file' requires at least one file argument.", [
        "Run 'dub split --by-file <files...> --name <new-branch>' to extract files.",
      ]);
    }
    if (!options.name) {
      throw new DubError("'--by-file' requires '--name <new-branch>'.", [
        "Run 'dub split --by-file <files...> --name feat/new-branch' to extract files.",
      ]);
    }
    await ensureUniqueAvailableBranchName(options.name, cwd);
    const changedFiles = await getDiffFileNamesBetween(
      parentBranch,
      sourceBranch,
      cwd,
    );
    const changedSet = new Set(changedFiles);
    for (const file of options.files) {
      if (!changedSet.has(file)) {
        throw new DubError(
          `File '${file}' is not part of '${sourceBranch}' diff vs '${parentBranch}'.`,
          [
            `Run 'git diff --name-only ${parentBranch}...${sourceBranch}' to see eligible files.`,
          ],
        );
      }
    }
    const byFileJournal = await startJournal();
    created.push(
      await extractByFiles({
        cwd,
        sourceBranch,
        parentBranch,
        parentTip,
        newBranchName: options.name,
        files: options.files,
        journal: byFileJournal,
      }),
    );
  } else if (options.mode === 'by-commit') {
    const commits = await listCommitsBetween(parentBranch, sourceBranch, cwd);
    if (commits.length === 0) {
      throw new DubError(
        `'${sourceBranch}' has no unique commits vs '${parentBranch}'.`,
        [
          "Run 'dub log' to confirm the branch state and rerun on a branch with commits.",
        ],
      );
    }
    if (commits.length === 1) {
      throw new DubError(
        `'${sourceBranch}' has only one commit. Nothing to split by commit.`,
        [
          "Run 'dub split --by-file <files...>' to split a single commit by file.",
          "Run 'dub split --by-hunk' to split a single commit by hunk.",
        ],
      );
    }
    let picks: number[];
    if (options.commitPicksRaw && options.commitPicksRaw.trim().length > 0) {
      // CLI path — parse the raw string against the real commit count so the
      // user gets a "pick numbers between 1 and N" message on a bad input.
      picks = parseIndexSelection(options.commitPicksRaw, commits.length);
    } else if (options.commitPicks && options.commitPicks.length > 0) {
      picks = validateCommitPicks(options.commitPicks, commits.length);
    } else {
      picks = await pickCommitsInteractive(commits, options);
    }
    if (picks.length === 0 || picks.length === commits.length) {
      throw new DubError(
        'Commit selection must move at least one and leave at least one.',
        [
          'Pick a strict subset of commits (e.g. 1 of 3 or 2 of 5).',
          "Run 'dub split --by-commit' again and re-enter your selection.",
        ],
      );
    }
    const newBranchName = await resolveNewBranchName(options, cwd);
    const byCommitJournal = await startJournal();
    created.push(
      await extractByCommits({
        cwd,
        sourceBranch,
        parentBranch,
        parentTip,
        commits,
        picks,
        newBranchName,
        journal: byCommitJournal,
      }),
    );
  } else if (options.mode === 'by-hunk') {
    const newBranchName = await resolveNewBranchName(options, cwd);
    const byHunkJournal = await startJournal();
    created.push(
      await extractByHunks({
        cwd,
        sourceBranch,
        parentBranch,
        parentTip,
        newBranchName,
        journal: byHunkJournal,
      }),
    );
  } else {
    throw new DubError(`Unknown split mode '${String(options.mode)}'.`, [
      "Pass one of '--by-commit', '--by-file <files...>', '--by-hunk', '--ai'.",
    ]);
  }

  await checkoutBranch(sourceBranch, cwd);
  const sourceTipAfter = await getBranchTip(sourceBranch, cwd);
  const sourceEmpty = sourceTipAfter === parentTip;

  let prClosed = false;
  if (existingPrNumber != null && (sourceEmpty || options.closeOldPr)) {
    const newRefs = created.map((c) => `'${c.branch}'`).join(', ');
    const comment = sourceEmpty
      ? `Closed by \`dub split\` — all commits moved to ${newRefs}.`
      : `Closed by \`dub split --close-old-pr\` — content moved to ${newRefs}.`;
    try {
      await closePr(existingPrNumber, cwd, { comment });
      prClosed = true;
    } catch (error) {
      // Non-fatal: surface but keep the split successful.
      const reason = error instanceof DubError ? error.message : String(error);
      console.warn(
        `⚠ Failed to close PR #${existingPrNumber}: ${reason}. Close it manually.`,
      );
    }
    if (prClosed && sourceEmpty) {
      // The source branch is now empty relative to parent. We leave the branch
      // pointer alone (the user may want to keep the branch for context) but
      // the PR side is reconciled. Drop pr_number/link from state so the next
      // submit treats it as a fresh branch.
      // Only run this when closePr actually succeeded — otherwise state and
      // GitHub would silently desync (an open PR with no recorded pr_number).
      // Journal the intent first so a crash between this point and writeState
      // is recoverable by `dub continue`.
      //
      // Reaching this branch implies an extractor ran, which means the lazy
      // `startJournal()` has fired and `journal` is non-null. We call
      // `startJournal()` again here as a belt-and-suspenders guarantee so a
      // future code path that lands in `sourceEmpty` without an extractor
      // can't silently skip the journal append.
      const j = await startJournal();
      await appendCleanupOperation(cwd, j, {
        type: 'split-clear-source-pr',
        branch: sourceBranch,
      });
      const refreshed = await readState(cwd);
      const refreshedBranch = findBranch(refreshed, sourceBranch);
      if (refreshedBranch) {
        refreshedBranch.pr_number = null;
        refreshedBranch.pr_link = null;
        await writeState(refreshed, cwd);
      }
    }
  }

  let restacked = false;
  if (!options.noRestack && sourceTipAfter !== sourceTipBefore) {
    const result = await restack(cwd);
    restacked = result.status === 'success' || result.status === 'up-to-date';
  }

  // Everything landed cleanly — drop the journal so `dub continue` doesn't
  // try to replay a completed split. Leaving the journal on disk would also
  // block any subsequent `dub split` via the hasCleanupJournal preflight.
  if (journal !== null) {
    await clearCleanupJournal(cwd);
  }

  return {
    sourceBranch,
    parentBranch,
    created,
    sourceEmpty,
    existingPrNumber,
    prClosed,
    restacked,
    aiProposal,
  };
}

interface ExtractByFilesInput {
  cwd: string;
  sourceBranch: string;
  parentBranch: string;
  parentTip: string;
  newBranchName: string;
  files: string[];
  summary?: string;
  /** Cleanup journal the extractor appends its track-branch op to. */
  journal: CleanupJournal;
}

/**
 * Moves the given files from the source branch's tip onto a fresh sibling
 * branch off the source's parent, and adds a removal commit to the source
 * branch so the net diff is preserved.
 *
 * Squash-style: a single commit captures the file changes on the new branch
 * and a single removal commit captures the inverse on the source branch.
 */
async function extractByFiles(
  input: ExtractByFilesInput,
): Promise<SplitNewBranchResult> {
  const {
    cwd,
    sourceBranch,
    parentBranch,
    parentTip,
    newBranchName,
    files,
    summary,
    journal,
  } = input;

  const sourceTip = await getBranchTip(sourceBranch, cwd);

  // 1) Create the new sibling branch anchored to the captured `parentTip` SHA
  //    rather than the `parentBranch` ref. This guarantees the new branch
  //    starts where we expect even if a concurrent fetch updates the parent
  //    ref between the snapshot in split() and this point.
  await createBranchFrom(newBranchName, parentTip, cwd);

  // 2) Apply the source-tip contents of the selected files onto the new branch.
  //    Files that exist at the source tip get checked out; files that exist
  //    only at parent (deleted on source) must be removed here so the new
  //    branch reflects the deletion.
  const existsAtSource = new Set(await listPathsAtRef(sourceTip, files, cwd));
  const existsAtParent = new Set(await listPathsAtRef(parentTip, files, cwd));
  const filesToCopy = files.filter((f) => existsAtSource.has(f));
  const filesToDelete = files.filter(
    (f) => !existsAtSource.has(f) && existsAtParent.has(f),
  );

  if (filesToCopy.length > 0) {
    await checkoutPathsFromRef(sourceTip, filesToCopy, cwd);
    await addPaths(filesToCopy, cwd);
  }
  if (filesToDelete.length > 0) {
    await removePaths(filesToDelete, cwd);
  }

  if (!(await hasStagedChanges(cwd))) {
    // Cleanup the empty branch and bail with a clear error.
    await checkoutBranch(sourceBranch, cwd);
    // Branch was created above; remove it so the state stays clean.
    await safeDeleteBranch(newBranchName, cwd);
    throw new DubError(
      `No diff to extract for '${newBranchName}' (files unchanged vs parent).`,
      [
        `Run 'git diff --name-only ${parentBranch}...${sourceBranch}' to see eligible files.`,
      ],
    );
  }

  const message = buildExtractCommitMessage({
    sourceBranch,
    newBranchName,
    files,
    summary,
  });
  try {
    await commitStaged(message, cwd);
  } catch (error) {
    await checkoutBranch(sourceBranch, cwd);
    await safeDeleteBranch(newBranchName, cwd);
    throw error;
  }
  const newBranchTip = await getBranchTip(newBranchName, cwd);

  // 3) On the source branch, invert the change for these files (so the source
  //    branch's net diff vs parent excludes them). Rolling back if anything
  //    here fails keeps state and git in sync — we only persist new-branch
  //    state after both sides land.
  try {
    await checkoutBranch(sourceBranch, cwd);
    const existsAtParentForRevert = await listPathsAtRef(parentTip, files, cwd);
    const filesPresentOnParent = new Set(existsAtParentForRevert);
    const restoreFromParent = files.filter((f) => filesPresentOnParent.has(f));
    const deleteOnSource = files.filter((f) => !filesPresentOnParent.has(f));

    if (restoreFromParent.length > 0) {
      await checkoutPathsFromRef(parentTip, restoreFromParent, cwd);
      await addPaths(restoreFromParent, cwd);
    }
    if (deleteOnSource.length > 0) {
      const existsNowOnSource = new Set(
        await listPathsAtRef(sourceTip, deleteOnSource, cwd),
      );
      const toRemove = deleteOnSource.filter((f) => existsNowOnSource.has(f));
      if (toRemove.length > 0) {
        await removePaths(toRemove, cwd);
      }
    }

    if (await hasStagedChanges(cwd)) {
      const removalMessage = `split: drop ${files.length} file(s) extracted to '${newBranchName}'\n\nMoved to branch '${newBranchName}'.`;
      await commitStaged(removalMessage, cwd);
    }
  } catch (error) {
    // Roll back: restore source to its original tip and delete the new branch.
    await checkoutBranch(sourceBranch, cwd).catch(() => {});
    await resetHard(sourceTip, cwd).catch(() => {});
    await safeDeleteBranch(newBranchName, cwd);
    throw error;
  }

  // Both sides landed cleanly — journal the state-tracking intent first,
  // then persist state. A crash between append and writeState is recoverable
  // because replay sees the branch exists in git but not in state and adds it.
  await appendCleanupOperation(cwd, journal, {
    type: 'split-track-branch',
    branch: newBranchName,
    parent: parentBranch,
    parentTip,
    sourceBranch,
  });
  const stateAfterCreate = await readState(cwd);
  addBranchToStack(stateAfterCreate, newBranchName, parentBranch, parentTip);
  await writeState(stateAfterCreate, cwd);

  return {
    branch: newBranchName,
    parent: parentBranch,
    files,
    commits: [newBranchTip],
  };
}

interface ExtractByCommitsInput {
  cwd: string;
  sourceBranch: string;
  parentBranch: string;
  parentTip: string;
  commits: CommitInfo[];
  picks: number[];
  newBranchName: string;
  /** Cleanup journal the extractor appends its track-branch op to. */
  journal: CleanupJournal;
}

/**
 * Moves the selected commits onto a fresh sibling branch, then rewrites the
 * source branch with only the remaining commits. Original commit subjects
 * survive on both sides because cherry-pick preserves them.
 */
async function extractByCommits(
  input: ExtractByCommitsInput,
): Promise<SplitNewBranchResult> {
  const {
    cwd,
    sourceBranch,
    parentBranch,
    parentTip,
    commits,
    picks,
    newBranchName,
    journal,
  } = input;
  const pickSet = new Set(picks);
  const movedCommits = picks.map((i) => commits[i].sha);
  const remainingCommits = commits
    .filter((_, i) => !pickSet.has(i))
    .map((c) => c.sha);
  const sourceTipBefore = await getBranchTip(sourceBranch, cwd);

  // Anchor to the captured parentTip SHA so a concurrent fetch can't relocate
  // the new branch's starting commit.
  await createBranchFrom(newBranchName, parentTip, cwd);
  for (const sha of movedCommits) {
    try {
      await cherryPick(sha, cwd);
    } catch (error) {
      await cherryPickAbort(cwd);
      await checkoutBranch(sourceBranch, cwd);
      await safeDeleteBranch(newBranchName, cwd);
      throw error;
    }
  }

  // Rewrite source branch with only remaining commits. If anything fails we
  // restore source to its pre-split tip and delete the new branch so state and
  // git stay coherent (no half-tracked branches).
  try {
    await checkoutBranch(sourceBranch, cwd);
    await resetHard(parentTip, cwd);
    for (const sha of remainingCommits) {
      try {
        await cherryPick(sha, cwd);
      } catch {
        await cherryPickAbort(cwd);
        throw new DubError(
          `Cherry-pick of remaining commit '${sha}' failed when rewriting '${sourceBranch}'.`,
          [
            "Resolve the conflict manually and run 'git cherry-pick --continue'.",
            "Run 'dub split --by-commit' again after restoring the source branch.",
          ],
        );
      }
    }
  } catch (error) {
    // Roll back: restore source to its original tip and delete the new branch.
    await checkoutBranch(sourceBranch, cwd).catch(() => {});
    await resetHard(sourceTipBefore, cwd).catch(() => {});
    await safeDeleteBranch(newBranchName, cwd);
    throw error;
  }

  // Both sides landed cleanly — journal the state-tracking intent first,
  // then persist state. Replay handles the gap between append and writeState.
  await appendCleanupOperation(cwd, journal, {
    type: 'split-track-branch',
    branch: newBranchName,
    parent: parentBranch,
    parentTip,
    sourceBranch,
  });
  const stateAfterCreate = await readState(cwd);
  addBranchToStack(stateAfterCreate, newBranchName, parentBranch, parentTip);
  await writeState(stateAfterCreate, cwd);

  return {
    branch: newBranchName,
    parent: parentBranch,
    commits: movedCommits,
  };
}

interface ExtractByHunksInput {
  cwd: string;
  sourceBranch: string;
  parentBranch: string;
  parentTip: string;
  newBranchName: string;
  /** Cleanup journal the extractor appends its track-branch op to. */
  journal: CleanupJournal;
}

/**
 * Interactive hunk-level split.
 *
 * Flow (one interactive pass, both sides committed deterministically):
 *   1. Snapshot sourceTip, parentTip.
 *   2. Create the new branch from sourceTip.
 *   3. Soft-reset the new branch to parentTip — index now holds every source
 *      change as staged, working tree clean.
 *   4. `git reset --patch HEAD` interactively — user answers `y` to UNSTAGE
 *      hunks (those become "stays on source"); `n` keeps hunks in the index
 *      (those become the new branch's commit).
 *   5. Stash the working-tree remainder (--keep-index) so we can replay it
 *      onto the source branch.
 *   6. Commit the index on the new branch.
 *   7. Switch to source, hard-reset to parent, pop the stash, commit.
 *
 * On error we restore both branches to their pre-split state and drop the
 * temporary stash so the user is never left with half-applied changes.
 */
async function extractByHunks(
  input: ExtractByHunksInput,
): Promise<SplitNewBranchResult> {
  const { cwd, sourceBranch, parentBranch, parentTip, newBranchName, journal } =
    input;
  const sourceTip = await getBranchTip(sourceBranch, cwd);

  const fullDiff = await getDiffBetween(parentBranch, sourceBranch, cwd);
  if (fullDiff.length === 0) {
    throw new DubError(`'${sourceBranch}' has no diff vs '${parentBranch}'.`, [
      "Run 'dub log' to confirm the branch state.",
    ]);
  }

  // Create the new branch from sourceTip so we can soft-reset it back to
  // parent without moving the source branch pointer. Anchor to the captured
  // sourceTip SHA so a concurrent fetch can't relocate the starting commit.
  await createBranchFrom(newBranchName, sourceTip, cwd);

  let stashed = false;
  let newBranchTip: string;
  try {
    await softResetTo(parentTip, cwd);

    console.log('');
    console.log(
      `Interactive hunk split: hunks you answer 'y' to MOVE to '${sourceBranch}'.`,
    );
    console.log(`Hunks you answer 'n' to STAY on '${newBranchName}'.`);
    console.log("Use 'q' to abort, '?' for help.");
    console.log('');
    await interactiveResetPatch(cwd);

    const stagedRemaining = await hasStagedChanges(cwd);
    // After softResetTo(parentTip) the index is dirty by construction, so a
    // generic "tree is dirty" check would always be true even when the user
    // unstaged nothing. Check the unstaged diff specifically — that's exactly
    // the content earmarked for the source branch.
    const unstagedRemaining = await hasUnstagedTrackedChanges(cwd);

    if (!stagedRemaining) {
      // Everything was unstaged — nothing left for the new branch.
      throw new DubError(
        `Hunk split aborted: every hunk was sent to '${sourceBranch}', leaving '${newBranchName}' empty.`,
        [
          "Run 'dub split --by-hunk' again and answer 'n' to at least one hunk.",
        ],
      );
    }
    if (!unstagedRemaining) {
      // Nothing was unstaged — nothing left for the source branch.
      throw new DubError(
        `Hunk split aborted: no hunks were moved back to '${sourceBranch}'.`,
        [
          "Run 'dub split --by-hunk' again and answer 'y' to at least one hunk.",
        ],
      );
    }

    // Stash the unstaged remainder so we can apply it to source after committing
    // the index on the new branch.
    stashed = await stashKeepIndex(
      `dubstack-split: ${sourceBranch} -> ${newBranchName}`,
      cwd,
    );

    const message = `split: extract hunks to '${newBranchName}'\n\nExtracted from '${sourceBranch}' via 'dub split --by-hunk'.`;
    await commitStaged(message, cwd);
    newBranchTip = await getBranchTip(newBranchName, cwd);

    // Now apply the stash to the source branch.
    await checkoutBranch(sourceBranch, cwd);
    await resetHard(parentTip, cwd);
    if (stashed) {
      await stashPop(cwd);
      stashed = false;
      // `git stash pop` on a --keep-index stash restores changes into the
      // working tree, not the index. Stage everything (including deletions
      // and untracked files) so the source-branch commit captures the full
      // remainder. Diffing parent vs HEAD here would be a no-op because the
      // hard-reset above already moved HEAD to parent.
      await stageAll(cwd);
      if (!(await hasStagedChanges(cwd))) {
        // Nothing to commit — abort cleanly.
        throw new DubError(
          `Hunk split: stash pop produced no changes for '${sourceBranch}'.`,
          [
            "Inspect the repo state with 'git status' and 'dub split --by-hunk' again.",
          ],
        );
      }
      const sourceMessage = `split: retain hunks not moved to '${newBranchName}'`;
      await commitStaged(sourceMessage, cwd);
    }
  } catch (error) {
    // Roll back both branches and drop any stash we created.
    if (stashed) {
      // Pop and discard so we don't leak a stash entry, even if pop fails.
      try {
        await stashPop(cwd);
      } catch {
        // Force-drop the stash even if pop didn't clean it up; the working
        // tree is about to be hard-reset away anyway.
        await stashDropTop(cwd);
      }
    }
    await checkoutBranch(sourceBranch, cwd).catch(() => {});
    await resetHard(sourceTip, cwd).catch(() => {});
    await safeDeleteBranch(newBranchName, cwd);
    if (error instanceof InteractivePatchQuitError) {
      // Translate the quit signal into a clear user-facing message; the
      // rollback above already restored both branches.
      throw new DubError(
        `Hunk split aborted by user — '${sourceBranch}' restored to its pre-split tip.`,
        [
          "Run 'dub split --by-hunk' again when ready to pick hunks.",
          "Run 'dub split --by-file <files...>' to split by file instead.",
        ],
      );
    }
    throw error;
  }

  // Both sides landed cleanly — journal the state-tracking intent first,
  // then persist state. Replay handles the gap between append and writeState.
  await appendCleanupOperation(cwd, journal, {
    type: 'split-track-branch',
    branch: newBranchName,
    parent: parentBranch,
    parentTip,
    sourceBranch,
  });
  const stateAfterCreate = await readState(cwd);
  addBranchToStack(stateAfterCreate, newBranchName, parentBranch, parentTip);
  await writeState(stateAfterCreate, cwd);

  return {
    branch: newBranchName,
    parent: parentBranch,
    commits: [newBranchTip],
  };
}

interface ProposeAiSplitInput {
  cwd: string;
  sourceBranch: string;
  parentBranch: string;
  parentTip: string;
  sourceTip: string;
  deps: SplitDependencies;
  providerConfig: Awaited<ReturnType<typeof readConfig>>['ai']['provider'];
}

async function proposeAiSplit(
  input: ProposeAiSplitInput,
): Promise<AiSplitProposal[]> {
  const { cwd, sourceBranch, parentBranch, deps, providerConfig } = input;
  const rawDiff = await getDiffBetween(parentBranch, sourceBranch, cwd);
  if (rawDiff.length === 0) {
    throw new DubError(`'${sourceBranch}' has no diff vs '${parentBranch}'.`, [
      "Run 'dub log' to confirm the branch state.",
    ]);
  }
  const changedFiles = await getDiffFileNamesBetween(
    parentBranch,
    sourceBranch,
    cwd,
  );
  const commits = await listCommitsBetween(parentBranch, sourceBranch, cwd);
  const diffContext = buildAiDiffContext({
    rawDiff,
    filePaths: changedFiles,
  });
  const proposals = await generateAiSplitProposal(
    {
      branch: sourceBranch,
      parentBranch,
      diff: diffContext,
      commitSubjects: commits.map((c) => c.subject),
      commitCount: commits.length,
      fileCount: changedFiles.length,
      knownFiles: changedFiles,
    },
    deps,
    providerConfig,
  );
  // Guard: every changed file must end up somewhere. If the model under-covers
  // we bail rather than silently dropping changes.
  const coverage = new Set<string>();
  for (const p of proposals) {
    for (const f of p.files) coverage.add(f);
  }
  const missing = changedFiles.filter((f) => !coverage.has(f));
  if (missing.length > 0) {
    throw new DubError(
      `AI proposal omitted ${missing.length} file(s): ${missing.join(', ')}.`,
      [
        "Rerun 'dub split --ai' to retry generation.",
        "Run 'dub split --by-file <files...>' to drive the split manually.",
      ],
    );
  }
  return proposals;
}

async function confirmAiProposal(proposals: AiSplitProposal[]): Promise<void> {
  console.log('');
  console.log('AI-proposed split:');
  console.log('');
  for (const [i, p] of proposals.entries()) {
    console.log(`  ${i + 1}. ${p.branch}`);
    if (p.summary) console.log(`     ${p.summary}`);
    for (const f of p.files) console.log(`       • ${f}`);
  }
  console.log('');
  const answer = (
    await input({
      message: 'Apply this split? (y/N)',
      default: 'N',
    })
  )
    .trim()
    .toLowerCase();
  if (answer !== 'y' && answer !== 'yes') {
    throw new DubError('Split aborted by user.', [
      "Rerun 'dub split --ai' to regenerate a proposal.",
      "Run 'dub split --by-file <files...>' to drive the split manually.",
    ]);
  }
}

function validateCommitPicks(picks: number[], total: number): number[] {
  const seen = new Set<number>();
  for (const p of picks) {
    if (!Number.isInteger(p) || p < 1 || p > total) {
      throw new DubError(`Invalid commit pick '${p}'.`, [
        `Pick numbers between 1 and ${total}.`,
      ]);
    }
    seen.add(p - 1);
  }
  return Array.from(seen).sort((a, b) => a - b);
}

async function pickCommitsInteractive(
  commits: CommitInfo[],
  options: SplitOptions,
): Promise<number[]> {
  if (options.interactive === false) {
    throw new DubError(
      "'--by-commit' requires interactive input; rerun without '--no-interactive'.",
      ["Run 'dub split --by-commit' in an interactive terminal."],
    );
  }
  console.log('');
  console.log('Commits on this branch (oldest first):');
  console.log('');
  for (const [i, c] of commits.entries()) {
    console.log(`  ${i + 1}. ${c.sha.slice(0, 7)}  ${c.subject}`);
  }
  console.log('');
  const raw = await input({
    message: 'Indices to MOVE to the new branch (e.g. "1 3" or "1-2,4"):',
  });
  return parseIndexSelection(raw, commits.length);
}

async function resolveNewBranchName(
  options: SplitOptions,
  cwd: string,
): Promise<string> {
  let name = options.name?.trim();
  if (!name) {
    if (options.interactive === false) {
      throw new DubError(
        'A new branch name is required; pass --name or run interactively.',
        ["Pass '--name <new-branch>' to skip the prompt."],
      );
    }
    name = (
      await input({ message: 'New branch name for the extracted commits:' })
    ).trim();
  }
  if (!name) {
    throw new DubError('New branch name cannot be empty.', [
      "Pass '--name <new-branch>' or enter a non-empty name at the prompt.",
    ]);
  }
  await ensureUniqueAvailableBranchName(name, cwd);
  return name;
}

async function ensureUniqueAvailableBranchName(
  name: string,
  cwd: string,
): Promise<void> {
  if (!(await isValidBranchName(name, cwd))) {
    throw new DubError(`Branch name '${name}' is invalid.`, [
      'Use only ASCII letters, digits, slashes, dots, dashes, and underscores.',
      'Avoid leading dashes, double-dots, and trailing slashes.',
    ]);
  }
  if (await branchExists(name, cwd)) {
    throw new DubError(`Branch '${name}' already exists.`, [
      `Run 'dub delete ${name}' to remove the existing branch first.`,
      "Pick a different branch name and rerun 'dub split'.",
    ]);
  }
}

function buildExtractCommitMessage(input: {
  sourceBranch: string;
  newBranchName: string;
  files: string[];
  summary?: string;
}): string {
  // Strip any leading Conventional Commit prefix the AI may have included in
  // its summary (e.g. "feat: add auth files") so we don't end up with
  // "split: feat: add auth files".
  const cleanedSummary = input.summary
    ?.trim()
    .replace(
      /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]+\))?!?:\s*/i,
      '',
    );
  const subjectBase =
    cleanedSummary && cleanedSummary.length > 0
      ? cleanedSummary
      : `extract ${input.files.length} file(s) from '${input.sourceBranch}'`;
  const subject = `split: ${subjectBase}`;
  const body = [
    `Extracted from '${input.sourceBranch}' via 'dub split'.`,
    'Files:',
    ...input.files.map((f) => `  - ${f}`),
  ].join('\n');
  return `${subject}\n\n${body}`;
}

async function safeDeleteBranch(name: string, cwd: string): Promise<void> {
  try {
    const { execa } = await import('../lib/exec');
    await execa('git', ['branch', '-D', name], { cwd });
  } catch {
    // Cleanup is best-effort; let the original error surface.
  }
}

function findBranch(
  state: { stacks: { branches: Branch[] }[] },
  name: string,
): Branch | undefined {
  for (const stack of state.stacks) {
    const branch = stack.branches.find((b) => b.name === name);
    if (branch) return branch;
  }
  return undefined;
}
