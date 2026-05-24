import chalk from 'chalk';
import type { LogRegion } from '../commands/log';
import type { BranchOverview } from './stack-overview';

const CI_GLYPH: Record<string, string> = {
  SUCCESS: '✔',
  FAILURE: '✖',
  PENDING: '●',
  NONE: '−',
};

const REVIEW_LABEL: Record<string, string> = {
  APPROVED: '✔ Approved',
  CHANGES_REQUESTED: '✗ Changes',
  REVIEW_REQUIRED: '… Review',
};

function reviewBadge(pr: BranchOverview['pr']): string {
  if (!pr) return '';
  if (pr.isDraft) return '✏ Draft';
  if (pr.reviewDecision && REVIEW_LABEL[pr.reviewDecision]) {
    return REVIEW_LABEL[pr.reviewDecision];
  }
  // Lifecycle fallback so closed/merged PRs still get a meaningful tag.
  if (pr.state === 'MERGED') return '⛓ Merged';
  if (pr.state === 'CLOSED') return '⊘ Closed';
  return 'Open';
}

/**
 * Builds the plain-text right-hand metadata column for a single branch.
 * Returns `''` when nothing is known (no PR + no local commit) so the
 * picker just shows the branch name.
 */
export function buildBranchMetaText(overview: BranchOverview | null): string {
  if (!overview) return '';
  const parts: string[] = [];
  if (overview.pr) {
    parts.push(`#${overview.pr.number}`);
    const review = reviewBadge(overview.pr);
    if (review) parts.push(review);
    parts.push(`CI ${CI_GLYPH[overview.pr.ciRollup] ?? '−'}`);
  }
  if (overview.commit?.committedRel) {
    parts.push(overview.commit.committedRel);
  }
  return parts.join(' · ');
}

function regionColor(region: LogRegion): (text: string) => string {
  switch (region) {
    case 'root':
      return (t) => chalk.bold(t);
    case 'ancestor':
      return (t) => chalk.cyan(t);
    case 'sibling-subtree':
      return (t) => chalk.dim(t);
    case 'current':
    case 'descendant':
      return (t) => t;
  }
}

export interface FormatBranchLabelOptions {
  branch: string;
  region: LogRegion | undefined;
  overview: BranchOverview | null;
  /** Column width used to align the metadata column. */
  branchColumnWidth: number;
  /** Disable ANSI escapes (mirrors `dub log --no-color`). */
  noColor: boolean;
}

/**
 * Renders one picker line: padded branch name + dim middle dot + metadata,
 * with the branch name colored by stack region. The metadata column is
 * always dim so the branch name stays the visual anchor.
 */
export function formatBranchLabel(opts: FormatBranchLabelOptions): string {
  const { branch, region, overview, branchColumnWidth, noColor } = opts;
  const meta = buildBranchMetaText(overview);
  const padded = branch.padEnd(branchColumnWidth);
  if (noColor) {
    return meta ? `${padded}  ${meta}` : branch;
  }
  const colorer = regionColor(region ?? 'descendant');
  const name = colorer(padded);
  if (!meta) return colorer(branch);
  return `${name}  ${chalk.dim(meta)}`;
}
