import {
  buildMetadataBlock,
  type DubstackMetadata,
  type DubstackMetadataTreeNode,
} from '../src/pr-body-parser.js';
import type {
  MergedPullInput,
  OpenPullSummary,
  RetargetClient,
  RetargetLogger,
} from '../src/retarget.js';

export interface FakePullBranch {
  number: number;
  branch: string;
  parent: string | null;
  depth: number;
}

export interface BuildStackInput {
  stackId: string;
  trunk: string;
  branches: FakePullBranch[];
}

export interface StackFakes {
  bodyByBranch: Map<string, string>;
  tree: DubstackMetadataTreeNode[];
}

/**
 * Builds a complete set of PR bodies for a stack. Every branch gets a
 * metadata block referencing the shared tree, plus a tiny visible table
 * and a one-line description so the strings exercise the parser/rewriter
 * the same way real bodies do.
 */
export function buildStackFakes(input: BuildStackInput): StackFakes {
  const tree: DubstackMetadataTreeNode[] = input.branches.map((b) => {
    const node: DubstackMetadataTreeNode = { name: b.branch, depth: b.depth };
    if (b.depth > 0) node.pr_number = b.number;
    return node;
  });

  const bodyByBranch = new Map<string, string>();
  for (const branch of input.branches) {
    if (branch.depth === 0) continue;

    const numbered = input.branches.filter((b) => b.depth > 0);
    const idx = numbered.findIndex((b) => b.number === branch.number);
    const prev = idx > 0 ? numbered[idx - 1] : null;
    const next = idx < numbered.length - 1 ? numbered[idx + 1] : null;
    const children = input.branches
      .filter((b) => b.parent === branch.branch)
      .map((b) => b.branch);

    const meta: DubstackMetadata = {
      schema_version: 1,
      stack_id: input.stackId,
      pr_number: branch.number,
      branch: branch.branch,
      parent: branch.parent,
      children,
      siblings: input.branches
        .filter((b) => b.parent === branch.parent && b.branch !== branch.branch)
        .map((b) => b.branch),
      prev_pr: prev ? prev.number : null,
      next_pr: next ? next.number : null,
      tree: tree.map((n) =>
        n.name === branch.branch ? { ...n, is_current: true } : n,
      ),
    };

    bodyByBranch.set(
      branch.branch,
      [
        `## Summary\n\n${branch.branch} description`,
        '<!-- dubstack:start -->',
        '---',
        '### 🥞 DubStack',
        ...meta.tree.map((n) => {
          const indent = '  '.repeat(n.depth);
          const label = n.pr_number ? `#${n.pr_number} ${n.name}` : n.name;
          const marker = n.is_current ? ' 👈' : '';
          return `${indent}- ${label}${marker}`;
        }),
        '<!-- dubstack:end -->',
        buildMetadataBlock(meta),
      ].join('\n\n'),
    );
  }

  return { bodyByBranch, tree };
}

export function makeMergedInput(
  fakes: StackFakes,
  branch: string,
  prNumber: number,
  baseRef: string,
): MergedPullInput {
  return {
    number: prNumber,
    merged: true,
    body: fakes.bodyByBranch.get(branch) ?? null,
    base: { ref: baseRef },
  };
}

export function makeOpenPulls(
  fakes: StackFakes,
  rows: {
    number: number;
    branch: string;
    base: string;
    title?: string;
    auto_merge?: unknown;
  }[],
): OpenPullSummary[] {
  return rows.map((row) => ({
    number: row.number,
    title: row.title ?? `PR for ${row.branch}`,
    body: fakes.bodyByBranch.get(row.branch) ?? null,
    base: { ref: row.base },
    head: { ref: row.branch },
    auto_merge: row.auto_merge ?? null,
  }));
}

export interface RecordingClient extends RetargetClient {
  calls: {
    baseUpdates: { number: number; base: string }[];
    bodyUpdates: { number: number; body: string }[];
    comments: { number: number; body: string }[];
    listed: number;
  };
}

export function createRecordingClient(
  openPulls: OpenPullSummary[],
  hooks: {
    onUpdateBase?: (prNumber: number, newBase: string) => Promise<void> | void;
  } = {},
): RecordingClient {
  const calls = {
    baseUpdates: [] as { number: number; base: string }[],
    bodyUpdates: [] as { number: number; body: string }[],
    comments: [] as { number: number; body: string }[],
    listed: 0,
  };

  return {
    calls,
    async listOpenPulls() {
      calls.listed += 1;
      return openPulls;
    },
    async updatePullBase(prNumber, newBase) {
      if (hooks.onUpdateBase) await hooks.onUpdateBase(prNumber, newBase);
      calls.baseUpdates.push({ number: prNumber, base: newBase });
    },
    async updatePullBody(prNumber, body) {
      calls.bodyUpdates.push({ number: prNumber, body });
    },
    async postComment(prNumber, body) {
      calls.comments.push({ number: prNumber, body });
    },
  };
}

export function silentLogger(): RetargetLogger {
  return { info: () => {}, warning: () => {}, error: () => {} };
}
