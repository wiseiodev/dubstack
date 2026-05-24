/**
 * Self-contained copy of the v1 dubstack-metadata parser + types from
 * `packages/cli/src/lib/pr-body.ts`. Kept in sync via
 * `test/parser-sync.test.ts`, which runs both implementations against the
 * shared fixture set and asserts byte-for-byte identical output.
 *
 * Why a copy and not a workspace import: the published Action ships a single
 * bundled `dist/index.js` served from the tag tree on GitHub Marketplace.
 * Importing from `packages/cli` would either bloat the bundle or require a
 * workspace-local dep that Marketplace consumers don't have.
 */

const METADATA_START = '<!-- dubstack-metadata';
const METADATA_END = '-->';

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

export function buildMetadataBlock(metadata: DubstackMetadata): string {
  return `${METADATA_START}\n${JSON.stringify(metadata, null, 2)}\n${METADATA_END}`;
}

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
