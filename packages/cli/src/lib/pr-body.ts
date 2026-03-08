import type { Branch } from './state';

interface StackEntry {
  number: number;
  title: string;
}

const DUBSTACK_START = '<!-- dubstack:start -->';
const DUBSTACK_END = '<!-- dubstack:end -->';
const METADATA_START = '<!-- dubstack-metadata';
const METADATA_END = '-->';

export interface DubstackMetadata {
  stack_id: string;
  pr_number: number;
  prev_pr: number | null;
  next_pr: number | null;
  branch: string;
}

/**
 * Builds the visible stack navigation table wrapped in dubstack markers.
 *
 * @param orderedBranches - Non-root branches in topological order
 * @param prMap - Map of branch name → PR number + title
 * @param currentBranch - The branch to mark with 👈
 */
export function buildStackTable(
  orderedBranches: Branch[],
  prMap: Map<string, StackEntry>,
  currentBranch: string,
): string {
  const lines = orderedBranches.map((branch) => {
    const entry = prMap.get(branch.name);
    if (!entry) return `- ${branch.name}`;
    const marker = branch.name === currentBranch ? ' 👈' : '';
    return `- #${entry.number} ${entry.title}${marker}`;
  });

  return [
    DUBSTACK_START,
    '---',
    '### 🥞 DubStack',
    ...lines,
    DUBSTACK_END,
  ].join('\n');
}

/**
 * Builds the hidden metadata HTML comment block.
 */
export function buildMetadataBlock(
  stackId: string,
  prNumber: number,
  prevPr: number | null,
  nextPr: number | null,
  branch: string,
): string {
  const metadata = {
    stack_id: stackId,
    pr_number: prNumber,
    prev_pr: prevPr,
    next_pr: nextPr,
    branch,
  };
  return `${METADATA_START}\n${JSON.stringify(metadata, null, 2)}\n${METADATA_END}`;
}

/**
 * Strips all DubStack-generated sections from a PR body.
 * Preserves user-written content. Returns body unchanged if no markers exist.
 */
export function stripDubstackSections(body: string): string {
  let result = body;

  const startIdx = result.indexOf(DUBSTACK_START);
  const endIdx = result.indexOf(DUBSTACK_END);
  if (startIdx !== -1 && endIdx !== -1) {
    result =
      result.slice(0, startIdx) + result.slice(endIdx + DUBSTACK_END.length);
  }

  const metaStart = result.indexOf(METADATA_START);
  if (metaStart !== -1) {
    const metaEnd = result.indexOf(
      METADATA_END,
      metaStart + METADATA_START.length,
    );
    if (metaEnd !== -1) {
      result =
        result.slice(0, metaStart) +
        result.slice(metaEnd + METADATA_END.length);
    }
  }

  return result.trimEnd();
}

/**
 * Composes the final PR body by combining user content with DubStack sections.
 *
 * @param existingBody - The existing PR body (may contain stale DubStack sections)
 * @param stackTable - Output of `buildStackTable`
 * @param metadataBlock - Output of `buildMetadataBlock`
 */
export function composePrBody(
  existingBody: string,
  stackTable: string,
  metadataBlock: string,
): string {
  const userContent = stripDubstackSections(existingBody);
  const parts = [userContent, stackTable, metadataBlock].filter(Boolean);
  return parts.join('\n\n');
}

/**
 * Parses hidden DubStack metadata from a PR body.
 * Returns null when metadata markers are absent or malformed.
 */
export function parseDubstackMetadata(body: string): DubstackMetadata | null {
  const start = body.indexOf(METADATA_START);
  if (start === -1) return null;

  const jsonStart = body.indexOf('\n', start);
  if (jsonStart === -1) return null;

  const end = body.indexOf(METADATA_END, jsonStart);
  if (end === -1) return null;

  const payload = body.slice(jsonStart, end).trim();
  try {
    const parsed = JSON.parse(payload) as Partial<DubstackMetadata>;
    if (
      typeof parsed.stack_id !== 'string' ||
      typeof parsed.pr_number !== 'number' ||
      (parsed.prev_pr !== null && typeof parsed.prev_pr !== 'number') ||
      (parsed.next_pr !== null && typeof parsed.next_pr !== 'number') ||
      typeof parsed.branch !== 'string'
    ) {
      return null;
    }
    return {
      stack_id: parsed.stack_id,
      pr_number: parsed.pr_number,
      prev_pr: parsed.prev_pr,
      next_pr: parsed.next_pr,
      branch: parsed.branch,
    };
  } catch {
    return null;
  }
}
