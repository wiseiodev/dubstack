import {
  buildMetadataBlock,
  type DubstackMetadata,
  type DubstackMetadataTreeNode,
  parseDubstackMetadata,
} from './pr-body-parser.js';

const DUBSTACK_START = '<!-- dubstack:start -->';
const DUBSTACK_END = '<!-- dubstack:end -->';
const METADATA_START = '<!-- dubstack-metadata';
const METADATA_END = '-->';

export interface OpenPullSummary {
  number: number;
  title: string;
  body: string | null;
  base: { ref: string };
  head: { ref: string };
  /**
   * When non-null, the PR is queued to auto-merge. We skip retargeting these
   * to avoid racing the in-flight merge.
   */
  auto_merge: unknown | null;
}

export interface MergedPullInput {
  number: number;
  merged: boolean;
  body: string | null;
  base: { ref: string };
}

export interface RetargetClient {
  listOpenPulls(): Promise<OpenPullSummary[]>;
  updatePullBase(prNumber: number, newBase: string): Promise<void>;
  updatePullBody(prNumber: number, body: string): Promise<void>;
  postComment(prNumber: number, body: string): Promise<void>;
}

export interface RetargetLogger {
  info(message: string): void;
  warning(message: string): void;
  error(message: string): void;
}

export type RetargetOutcome =
  | { status: 'skipped-not-merged' }
  | { status: 'skipped-no-metadata' }
  | { status: 'skipped-legacy-metadata' }
  | { status: 'no-dependents' }
  | {
      status: 'done';
      retargeted: RetargetedPr[];
      skipped: SkippedPr[];
    };

export interface RetargetedPr {
  number: number;
  fromBase: string;
  toBase: string;
}

export interface SkippedPr {
  number: number;
  reason: string;
}

/**
 * Core retarget routine. Pure — all GitHub access flows through `client`, so
 * the algorithm is exercised in unit tests with a mocked client.
 *
 * Behavior matches the algorithm spec in DUB-72:
 * 1. Bail if the triggering PR didn't actually merge.
 * 2. Bail if the merged PR has no dubstack-metadata (non-Dubstack repo).
 * 3. Bail if the merged PR's metadata is legacy-shaped (no `parent` link to
 *    follow).
 * 4. List open PRs; filter to those whose parsed metadata's `parent` equals
 *    the merged PR's `branch` field.
 * 5. For each dependent: update base, rewrite metadata + visible stack table,
 *    comment.
 */
export async function runRetarget(
  client: RetargetClient,
  mergedPr: MergedPullInput,
  log: RetargetLogger,
): Promise<RetargetOutcome> {
  if (!mergedPr.merged) {
    log.info('Not a merged PR, skipping');
    return { status: 'skipped-not-merged' };
  }

  const mergedMetadata = parseDubstackMetadata(mergedPr.body ?? '');
  if (!mergedMetadata) {
    log.info('No dubstack-metadata block, skipping (not a dubstack PR)');
    return { status: 'skipped-no-metadata' };
  }

  // The merged PR's `parent` is the base its dependents must move to. For
  // root-of-stack PRs the parent is null — in that case, dependents move to
  // the trunk (the merged PR's own base ref).
  const newBase = mergedMetadata.parent ?? mergedPr.base.ref;

  // Legacy metadata has no tree/children/parent links. We have no way to
  // discover dependents, so exit cleanly with a hint.
  const isLegacyShape =
    mergedMetadata.parent === null &&
    mergedMetadata.tree.length === 0 &&
    mergedMetadata.children.length === 0;
  if (isLegacyShape) {
    log.warning(
      'Legacy metadata — cannot retarget; user should re-submit with newer Dubstack CLI to refresh metadata.',
    );
    return { status: 'skipped-legacy-metadata' };
  }

  const open = await client.listOpenPulls();
  const titleByPr = new Map<number, string>();
  for (const pr of open) titleByPr.set(pr.number, pr.title);

  const dependents: { pr: OpenPullSummary; meta: DubstackMetadata }[] = [];
  for (const pr of open) {
    const meta = parseDubstackMetadata(pr.body ?? '');
    if (!meta) continue;
    if (meta.parent === mergedMetadata.branch) {
      dependents.push({ pr, meta });
    }
  }

  if (dependents.length === 0) {
    log.info('No dependents to retarget');
    return { status: 'no-dependents' };
  }

  const retargeted: RetargetedPr[] = [];
  const skipped: SkippedPr[] = [];

  for (const { pr, meta } of dependents) {
    if (pr.auto_merge != null) {
      log.info(`Skipping #${pr.number}: auto-merge in flight`);
      skipped.push({ number: pr.number, reason: 'auto-merge in flight' });
      continue;
    }

    const baseAlreadyCorrect = pr.base.ref === newBase;
    // After a successful retarget, the dependent's metadata `parent` should
    // equal `newBase` — that's what `updateMetadataForRetarget` writes. We
    // compare against `newBase` (not `mergedMetadata.parent`) so the check
    // stays correct in the root-merge case where `mergedMetadata.parent` is
    // null but the dependent should sit on the trunk.
    const metadataAlreadyCorrect = meta.parent === newBase;
    if (baseAlreadyCorrect && metadataAlreadyCorrect) {
      log.info(`Skipping #${pr.number}: already retargeted to ${newBase}`);
      skipped.push({ number: pr.number, reason: 'already retargeted' });
      continue;
    }

    const oldBase = pr.base.ref;

    if (!baseAlreadyCorrect) {
      try {
        await client.updatePullBase(pr.number, newBase);
      } catch (err) {
        if (isPermissionsError(err)) {
          throw new RetargetPermissionsError(pr.number, err);
        }
        // Transient or PR-specific failure (network, 422 base conflict, 404
        // PR gone). Skip this dependent but continue with the others.
        log.warning(
          `Failed to update base of #${pr.number}: ${errMessage(err)}. Continuing with remaining dependents.`,
        );
        skipped.push({
          number: pr.number,
          reason: `base update failed: ${errMessage(err)}`,
        });
        continue;
      }
    }

    // Body + comment are best-effort. If the base moved successfully but the
    // body rewrite fails (rate limit, transient 5xx), we log and continue
    // rather than fail the workflow — the next `dub submit` regenerates the
    // metadata block from the source of truth in .git/dubstack/state.json.
    const newMeta = updateMetadataForRetarget(
      meta,
      mergedMetadata.branch,
      newBase,
      mergedMetadata.pr_number,
    );
    const newBody = rewritePrBody(pr.body ?? '', newMeta, titleByPr);
    try {
      await client.updatePullBody(pr.number, newBody);
    } catch (err) {
      log.warning(
        `Failed to rewrite PR #${pr.number} body after retarget: ${errMessage(err)}. The base moved successfully; metadata will refresh on the next 'dub submit'.`,
      );
    }

    if (!baseAlreadyCorrect) {
      try {
        await client.postComment(
          pr.number,
          `Dubstack retargeted this PR from \`${oldBase}\` to \`${newBase}\` after #${mergedPr.number} merged.`,
        );
      } catch (err) {
        log.warning(
          `Failed to post retarget comment on PR #${pr.number}: ${errMessage(err)}.`,
        );
      }
      retargeted.push({
        number: pr.number,
        fromBase: oldBase,
        toBase: newBase,
      });
    } else {
      // Base was already correct (e.g. a teammate retargeted manually) but
      // metadata was stale; we just refreshed the body. Treat as a skip with
      // a distinct reason so callers can distinguish "no work" from
      // "metadata-only repair".
      skipped.push({
        number: pr.number,
        reason: 'metadata refreshed; base unchanged',
      });
    }
  }

  log.info(
    `Done. Retargeted ${retargeted.length} PR(s); skipped ${skipped.length}.`,
  );
  return { status: 'done', retargeted, skipped };
}

export class RetargetPermissionsError extends Error {
  readonly prNumber: number;
  readonly cause: unknown;
  constructor(prNumber: number, cause: unknown) {
    super(
      `403 Forbidden while updating PR #${prNumber}. Common causes: missing 'pull-requests: write' on the workflow, branch protection rules on the new base, or a fork-PR context where GITHUB_TOKEN is read-only.`,
    );
    this.name = 'RetargetPermissionsError';
    this.prNumber = prNumber;
    this.cause = cause;
  }
}

function isPermissionsError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const status = (err as { status?: number }).status;
  return status === 403;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Updates the dependent PR's metadata to reflect the merged PR being gone:
 * - `parent` swaps to `newParentBranch` — the same value we move the GitHub
 *   base to, so metadata stays consistent with the actual base ref.
 * - `prev_pr` clears when it pointed at the merged PR
 * - the merged branch is dropped from `tree[]`; descendants shift up one
 *   depth (the merged branch is no longer between them and the root).
 */
export function updateMetadataForRetarget(
  meta: DubstackMetadata,
  mergedBranch: string,
  newParentBranch: string,
  mergedPrNumber: number,
): DubstackMetadata {
  return {
    ...meta,
    parent: newParentBranch,
    prev_pr: meta.prev_pr === mergedPrNumber ? null : meta.prev_pr,
    tree: removeBranchFromTree(meta.tree, mergedBranch),
  };
}

/**
 * Drops `branchName` from a DFS-ordered tree array and shifts its descendants
 * up by one depth. Descendants are the contiguous block of nodes after the
 * removed index whose depth exceeds the removed node's depth.
 */
export function removeBranchFromTree(
  tree: DubstackMetadataTreeNode[],
  branchName: string,
): DubstackMetadataTreeNode[] {
  const mergedIdx = tree.findIndex((n) => n.name === branchName);
  if (mergedIdx === -1) return tree;
  const mergedDepth = tree[mergedIdx].depth;

  let descendantEnd = tree.length;
  for (let i = mergedIdx + 1; i < tree.length; i++) {
    if (tree[i].depth <= mergedDepth) {
      descendantEnd = i;
      break;
    }
  }

  const result: DubstackMetadataTreeNode[] = [];
  for (let i = 0; i < tree.length; i++) {
    if (i === mergedIdx) continue;
    if (i > mergedIdx && i < descendantEnd) {
      result.push({ ...tree[i], depth: tree[i].depth - 1 });
    } else {
      result.push(tree[i]);
    }
  }
  return result;
}

/**
 * Replaces the metadata block + visible stack table inside the existing PR
 * body. Preserves all user-authored content and any other DubStack-managed
 * sections (e.g. ai-summary) outside the two replaced regions.
 */
export function rewritePrBody(
  existing: string,
  newMeta: DubstackMetadata,
  titleByPr: Map<number, string>,
): string {
  const newMetaBlock = buildMetadataBlock(newMeta);
  const newTable = renderStackTable(newMeta, titleByPr);

  let body = existing;

  // Replace existing dubstack stack table (visible block).
  const tStart = body.indexOf(DUBSTACK_START);
  const tEnd = body.indexOf(DUBSTACK_END);
  if (tStart !== -1 && tEnd !== -1 && tEnd > tStart) {
    body =
      body.slice(0, tStart) + newTable + body.slice(tEnd + DUBSTACK_END.length);
  } else {
    // No existing visible block — append below body.
    body = `${body.trimEnd()}\n\n${newTable}`;
  }

  // Replace existing metadata block.
  const mStart = body.indexOf(METADATA_START);
  if (mStart !== -1) {
    const mEnd = body.indexOf(METADATA_END, mStart + METADATA_START.length);
    if (mEnd !== -1) {
      body =
        body.slice(0, mStart) +
        newMetaBlock +
        body.slice(mEnd + METADATA_END.length);
    } else {
      body = `${body.trimEnd()}\n\n${newMetaBlock}`;
    }
  } else {
    body = `${body.trimEnd()}\n\n${newMetaBlock}`;
  }

  return body.trim().replace(/\n{3,}/g, '\n\n');
}

/**
 * Renders the visible stack table from the metadata tree. Loses PR titles
 * only for branches that aren't currently open (e.g. the merged-and-gone
 * parent that previously sat above the dependent). Matches the CLI's
 * `buildStackTable` markdown contract closely enough that users won't see
 * unexpected formatting churn — the CLI overwrites this region on the next
 * `dub submit` regardless.
 */
export function renderStackTable(
  meta: DubstackMetadata,
  titleByPr: Map<number, string>,
): string {
  const lines: string[] = [DUBSTACK_START, '---', '### 🥞 DubStack'];
  for (const node of meta.tree) {
    const indent = '  '.repeat(node.depth);
    const marker = node.is_current ? ' 👈' : '';
    let label: string;
    if (node.pr_number !== undefined) {
      const title = titleByPr.get(node.pr_number);
      label = title
        ? `#${node.pr_number} ${title}`
        : `#${node.pr_number} ${node.name}`;
    } else {
      label = node.name;
    }
    lines.push(`${indent}- ${label}${marker}`);
  }
  lines.push(DUBSTACK_END);
  return lines.join('\n');
}
