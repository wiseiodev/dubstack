import type { Branch } from './state';

interface StackEntry {
  number: number;
  title: string;
}

const DUBSTACK_START = '<!-- dubstack:start -->';
const DUBSTACK_END = '<!-- dubstack:end -->';
const AI_SUMMARY_START = '<!-- dubstack-ai-summary:start -->';
const AI_SUMMARY_END = '<!-- dubstack-ai-summary:end -->';
const METADATA_START = '<!-- dubstack-metadata';
const METADATA_END = '-->';
const TRUNCATION_THRESHOLD = 40;

export interface DubstackMetadataTreeNode {
  name: string;
  depth: number;
  pr_number?: number;
  is_current?: boolean;
}

export interface DubstackMetadata {
  schema_version: 1;
  stack_id: string;
  pr_number: number;
  branch: string;
  parent: string | null;
  children: string[];
  siblings: string[];
  prev_pr: number | null;
  next_pr: number | null;
  tree: DubstackMetadataTreeNode[];
}

interface TreeNode {
  branch: Branch;
  children: TreeNode[];
  depth: number;
}

/**
 * Builds the visible stack navigation table wrapped in dubstack markers.
 * Renders the stack as an indented tree (2 spaces per level) with siblings
 * sorted alphabetically by branch name. The `currentBranch` gets a 👈 marker.
 *
 * For stacks with more than {@link TRUNCATION_THRESHOLD} branches, only the
 * current branch, its ancestors and their direct children (siblings + aunts/
 * uncles), and its descendants are shown. A summary line tags the number of
 * hidden branches.
 *
 * @param branches - All branches in the stack (root + children). Tree shape is
 *   derived from each branch's `parent` link.
 * @param prMap - Map of branch name → PR number + title. Branches without an
 *   entry render with their branch name and no PR number (e.g. the root).
 * @param currentBranch - The branch to mark with 👈.
 */
export function buildStackTable(
  branches: Branch[],
  prMap: Map<string, StackEntry>,
  currentBranch: string,
): string {
  const root = buildTree(branches);
  const truncate = branches.length > TRUNCATION_THRESHOLD;

  const lines: string[] = [];
  let hiddenCount = 0;

  if (root) {
    const visible = truncate ? computeVisibleNames(root, currentBranch) : null;
    const render = (node: TreeNode): void => {
      const indent = '  '.repeat(node.depth);
      lines.push(`${indent}- ${renderNodeLabel(node, prMap, currentBranch)}`);
      for (const child of node.children) {
        if (!visible || visible.has(child.branch.name)) {
          render(child);
        } else {
          hiddenCount += countSubtree(child);
        }
      }
    };
    render(root);
  } else {
    for (const b of branches) {
      const entry = prMap.get(b.name);
      const marker = b.name === currentBranch ? ' 👈' : '';
      lines.push(
        entry
          ? `- #${entry.number} ${entry.title}${marker}`
          : `- ${b.name}${marker}`,
      );
    }
  }

  if (hiddenCount > 0) {
    lines.push(
      `... (${hiddenCount} branches hidden, run 'dub log' to see all)`,
    );
  }

  return [
    DUBSTACK_START,
    '---',
    '### 🥞 DubStack',
    ...lines,
    DUBSTACK_END,
  ].join('\n');
}

/**
 * Builds the hidden v1 metadata HTML comment block. Stores the full tree shape
 * so downstream consumers (action webhooks, parsers) can rebuild the stack
 * without reading state.
 */
export function buildMetadataBlock(metadata: DubstackMetadata): string {
  return `${METADATA_START}\n${JSON.stringify(metadata, null, 2)}\n${METADATA_END}`;
}

/**
 * Builds the flat tree array stored inside the metadata block. Each entry
 * carries its depth so consumers can re-render the tree without re-walking the
 * parent links.
 */
export function buildMetadataTree(
  branches: Branch[],
  prMap: Map<string, StackEntry>,
  currentBranch: string,
): DubstackMetadataTreeNode[] {
  const root = buildTree(branches);
  if (!root) return [];

  const result: DubstackMetadataTreeNode[] = [];
  const walk = (node: TreeNode): void => {
    const entry = prMap.get(node.branch.name);
    const item: DubstackMetadataTreeNode = {
      name: node.branch.name,
      depth: node.depth,
    };
    if (entry) item.pr_number = entry.number;
    if (node.branch.name === currentBranch) item.is_current = true;
    result.push(item);
    for (const child of node.children) walk(child);
  };
  walk(root);
  return result;
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
 * Wraps an AI-managed PR summary in explicit markers so it can be replaced safely.
 */
export function buildAiSummarySection(summary: string): string {
  const trimmed = summary.trim();
  if (trimmed.length === 0) return '';
  return [AI_SUMMARY_START, trimmed, AI_SUMMARY_END].join('\n');
}

/**
 * Removes only the AI-managed summary section while preserving user-authored text.
 */
export function stripAiSummarySection(body: string): string {
  let result = body;

  while (true) {
    const startIdx = result.indexOf(AI_SUMMARY_START);

    if (startIdx === -1) {
      return normalizeBodyWhitespace(result);
    }

    const endIdx = result.indexOf(
      AI_SUMMARY_END,
      startIdx + AI_SUMMARY_START.length,
    );
    if (endIdx === -1) {
      return normalizeBodyWhitespace(result);
    }

    result =
      result.slice(0, startIdx) + result.slice(endIdx + AI_SUMMARY_END.length);
  }
}

/**
 * Composes the final PR body by combining user content with DubStack sections.
 *
 * @param existingBody - The existing PR body (may contain stale DubStack sections)
 * @param aiSummary - Human-readable AI-generated summary content
 * @param stackTable - Output of `buildStackTable`
 * @param metadataBlock - Output of `buildMetadataBlock`
 */
export function composePrBody(
  existingBody: string,
  aiSummary: string,
  stackTable: string,
  metadataBlock: string,
): string {
  const userContent = stripAiSummarySection(
    stripDubstackSections(existingBody),
  );
  const aiSection = buildAiSummarySection(aiSummary);
  const parts = [userContent, aiSection, stackTable, metadataBlock].filter(
    Boolean,
  );
  return parts.join('\n\n');
}

function normalizeBodyWhitespace(body: string): string {
  return body.trim().replace(/\n{3,}/g, '\n\n');
}

/**
 * Parses hidden DubStack metadata from a PR body. Accepts both the legacy
 * shape (no `schema_version`, no tree fields) and the v1 shape; legacy blocks
 * are migrated to v1 with empty `tree`/`siblings`/`children` and `parent: null`
 * so consumers can always rely on the v1 surface.
 *
 * Returns null when markers are absent, JSON is malformed, or required fields
 * are missing/invalid.
 */
export function parseDubstackMetadata(body: string): DubstackMetadata | null {
  const start = body.indexOf(METADATA_START);
  if (start === -1) return null;

  const jsonStart = body.indexOf('\n', start);
  if (jsonStart === -1) return null;

  const end = body.indexOf(METADATA_END, jsonStart);
  if (end === -1) return null;

  const payload = body.slice(jsonStart, end).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;

  if (
    typeof parsed.stack_id !== 'string' ||
    typeof parsed.pr_number !== 'number' ||
    typeof parsed.branch !== 'string' ||
    (parsed.prev_pr !== null && typeof parsed.prev_pr !== 'number') ||
    (parsed.next_pr !== null && typeof parsed.next_pr !== 'number')
  ) {
    return null;
  }

  if (parsed.schema_version !== undefined && parsed.schema_version !== 1) {
    return null;
  }

  return {
    schema_version: 1,
    stack_id: parsed.stack_id,
    pr_number: parsed.pr_number,
    branch: parsed.branch,
    parent:
      typeof parsed.parent === 'string' || parsed.parent === null
        ? (parsed.parent as string | null)
        : null,
    children: parseStringArray(parsed.children),
    siblings: parseStringArray(parsed.siblings),
    prev_pr: parsed.prev_pr as number | null,
    next_pr: parsed.next_pr as number | null,
    tree: parseTreeArray(parsed.tree),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

function parseTreeArray(value: unknown): DubstackMetadataTreeNode[] {
  if (!Array.isArray(value)) return [];
  const result: DubstackMetadataTreeNode[] = [];
  for (const item of value) {
    if (!isPlainObject(item)) continue;
    if (typeof item.name !== 'string' || typeof item.depth !== 'number') {
      continue;
    }
    const node: DubstackMetadataTreeNode = {
      name: item.name,
      depth: item.depth,
    };
    if (typeof item.pr_number === 'number') node.pr_number = item.pr_number;
    if (item.is_current === true) node.is_current = true;
    result.push(node);
  }
  return result;
}

function buildTree(branches: Branch[]): TreeNode | null {
  const root = branches.find((b) => b.type === 'root' || b.parent === null);
  if (!root) return null;

  const childMap = new Map<string, Branch[]>();
  for (const branch of branches) {
    if (branch.parent != null && branch !== root) {
      const arr = childMap.get(branch.parent) ?? [];
      arr.push(branch);
      childMap.set(branch.parent, arr);
    }
  }
  for (const arr of childMap.values()) {
    arr.sort((a, b) => a.name.localeCompare(b.name));
  }

  const seen = new Set<string>();
  const build = (branch: Branch, depth: number): TreeNode => {
    seen.add(branch.name);
    const children = (childMap.get(branch.name) ?? [])
      .filter((c) => !seen.has(c.name))
      .map((c) => build(c, depth + 1));
    return { branch, children, depth };
  };

  return build(root, 0);
}

function renderNodeLabel(
  node: TreeNode,
  prMap: Map<string, StackEntry>,
  currentBranch: string,
): string {
  const entry = prMap.get(node.branch.name);
  const marker = node.branch.name === currentBranch ? ' 👈' : '';
  if (!entry) return `${node.branch.name}${marker}`;
  return `#${entry.number} ${entry.title}${marker}`;
}

function countSubtree(node: TreeNode): number {
  let count = 1;
  for (const child of node.children) count += countSubtree(child);
  return count;
}

function computeVisibleNames(
  root: TreeNode,
  currentBranch: string,
): Set<string> {
  const byName = new Map<string, TreeNode>();
  const collect = (node: TreeNode): void => {
    byName.set(node.branch.name, node);
    for (const child of node.children) collect(child);
  };
  collect(root);

  const visible = new Set<string>();
  const current = byName.get(currentBranch);
  if (!current) {
    // Unknown current branch — render full tree rather than hide everything.
    for (const name of byName.keys()) visible.add(name);
    return visible;
  }

  // Ancestor path (root → current) — also gives us "ancestors of current".
  const ancestors: TreeNode[] = [];
  let cursor: TreeNode | undefined = current;
  while (cursor) {
    ancestors.unshift(cursor);
    const parentName: string | null = cursor.branch.parent;
    cursor = parentName ? byName.get(parentName) : undefined;
  }
  for (const a of ancestors) visible.add(a.branch.name);

  // Direct children of each ancestor (siblings + aunts/uncles).
  for (const a of ancestors) {
    for (const child of a.children) visible.add(child.branch.name);
  }

  // All descendants of current.
  const addDescendants = (node: TreeNode): void => {
    for (const child of node.children) {
      visible.add(child.branch.name);
      addDescendants(child);
    }
  };
  addDescendants(current);

  return visible;
}
