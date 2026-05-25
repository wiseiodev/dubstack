import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as readline from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { fromIni, fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { createGateway, generateText } from 'ai';
import { buildAiDiffContext } from '../lib/ai-diff-context';
import {
  type AiMetadataDependencies,
  generateCreateMetadata,
  generatePrDescriptionSummary,
} from '../lib/ai-metadata';
import { type McpMode, readConfig } from '../lib/config';
import { DubError, formatDubError } from '../lib/errors';
import { getCurrentBranch, getDiffBetween } from '../lib/git';
import { appendHistoryEntry, redactSensitiveText } from '../lib/history';
import { readMetadataTemplates } from '../lib/metadata-templates';
import { detectActiveOperation } from '../lib/operation-state';
import type { RebaseTodoEntry } from '../lib/rebase-todo';
import type { ScopeMode } from '../lib/scope';
import { getStackOverviewBatch } from '../lib/stack-overview';
import { absorb } from './absorb';
import { back } from './back';
import { branchInfo } from './branch';
import { checkout } from './checkout';
import { children } from './children';
import { create } from './create';
import { deleteCommand } from './delete';
import { doctor } from './doctor';
import { fold } from './fold';
import { freeze } from './freeze';
import { history } from './history';
import { logJson } from './log';
import { mergeCheck } from './merge-check';
import { modify } from './modify';
import { move } from './move';
import { parent } from './parent';
import { pop } from './pop';
import { ready } from './ready';
import { rename } from './rename';
import { reorder } from './reorder';
import { revert } from './revert';
import { type SplitMode, split } from './split';
import { squash } from './squash';
import { stashList, stashPop, stashPush } from './stash';
import { status } from './status';
import { submit } from './submit';
import { sync } from './sync';
import { trunk } from './trunk';
import { unfreeze } from './unfreeze';
import { unlink } from './unlink';

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface ConfirmationResult {
  confirmed: boolean;
  reason: string;
}

export type ConfirmMutatingFn = (
  name: string,
  args: Record<string, unknown>,
) => Promise<ConfirmationResult>;

interface McpServerOptions {
  input?: Readable;
  output?: Writable;
  version?: string;
  confirmMutating?: ConfirmMutatingFn;
  aiMetadataDeps?: AiMetadataDependencies;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonValue;
  mutating?: boolean;
}

interface ToolCallResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: JsonValue;
  isError?: boolean;
}

const PROTOCOL_VERSION = '2025-11-25';
const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2025-11-25', '2025-06-18']);
const MAX_HISTORY_ARGS_LENGTH = 500;

const DEFAULT_AI_METADATA_DEPS: AiMetadataDependencies = {
  generateText,
  createGoogleGenerativeAI,
  createGateway,
  createAmazonBedrock,
  fromIni,
  fromNodeProviderChain,
};

const HISTORY_ARG_KEYS: Record<string, string[]> = {
  'dubstack.log': ['stack', 'all', 'reverse', 'prs', 'ci', 'refresh'],
  'dubstack.doctor': ['all', 'fetch'],
  'dubstack.status': ['live', 'pr'],
  'dubstack.parent': ['branch'],
  'dubstack.children': ['branch'],
  'dubstack.trunk': ['branch'],
  'dubstack.history': ['limit'],
  'dubstack.branch': ['branch'],
  'dubstack.diff': ['branch', 'base'],
  'dubstack.ready': ['scope'],
  'dubstack.merge_check': ['pr', 'branch', 'scope'],
  'dubstack.propose_branch_name': ['diff'],
  'dubstack.propose_commit_message': ['diff'],
  'dubstack.propose_pr_description': [
    'branch',
    'baseBranch',
    'commitMessage',
    'diff',
  ],
  'dubstack.create': ['name', 'message', 'ai'],
  'dubstack.modify': ['message', 'commit', 'all'],
  'dubstack.submit': [
    'dryRun',
    'upstack',
    'downstack',
    'stack',
    'branch',
    'path',
    'fix',
  ],
  'dubstack.sync': ['force', 'all'],
  'dubstack.checkout': ['branch'],
  'dubstack.back': ['steps'],
  'dubstack.delete': ['branch', 'upstack', 'downstack', 'force'],
  'dubstack.reorder': ['entries'],
  'dubstack.revert': ['target', 'branch', 'submit'],
  'dubstack.unlink': ['branch', 'noRetarget', 'orphanChildren'],
  'dubstack.stash': ['message'],
  'dubstack.stash-pop': ['on', 'force'],
  'dubstack.stash-list': [],
  'dubstack.freeze': ['branch', 'upstack', 'downstack'],
  'dubstack.unfreeze': ['branch', 'upstack', 'downstack'],
  'dubstack.absorb': ['ai', 'stack', 'dryRun'],
  'dubstack.split': [
    'mode',
    'files',
    'name',
    'commitPicks',
    'commitPicksRaw',
    'closeOldPr',
    'noRestack',
    'dryRun',
    'yes',
  ],
  'dubstack.squash': ['message', 'ai'],
  'dubstack.fold': ['squash', 'force'],
  'dubstack.pop': ['steps'],
  'dubstack.rename': ['oldName', 'newName', 'noPush'],
  'dubstack.move': ['branch', 'before', 'after'],
};

const BRANCH_SCHEMA = {
  type: 'object',
  properties: {
    branch: {
      type: 'string',
      description: 'Branch to inspect. Defaults to the current branch.',
    },
  },
  additionalProperties: false,
} satisfies JsonValue;

const TOOLS: ToolDefinition[] = [
  {
    name: 'dubstack.log',
    description:
      'Return the tracked DubStack stack tree as structured JSON, with optional PR/CI/commit annotations per branch.',
    inputSchema: {
      type: 'object',
      properties: {
        stack: {
          type: 'boolean',
          description: 'Only include the current tracked stack.',
        },
        all: {
          type: 'boolean',
          description: 'Include all tracked stacks.',
        },
        reverse: {
          type: 'boolean',
          description: 'Reverse stack and child ordering.',
        },
        prs: {
          type: 'boolean',
          description:
            'Include PR-state annotations (prState, prTitle, reviewDecision, draft) when overview data is available. Defaults to true.',
        },
        ci: {
          type: 'boolean',
          description:
            'Include CI rollup (ciState) when overview data is available. Defaults to true.',
        },
        refresh: {
          type: 'boolean',
          description: 'Bust the 30-second overview cache before fetching.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'dubstack.doctor',
    description: 'Return DubStack health issues and remediation steps.',
    inputSchema: {
      type: 'object',
      properties: {
        all: {
          type: 'boolean',
          description: 'Check all stacks instead of only the current stack.',
        },
        fetch: {
          type: 'boolean',
          description: 'Refresh remote refs before remote drift checks.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'dubstack.status',
    description:
      'Return current branch, tracking, PR state, and drift issues. Defaults to the cached overview snapshot for fast reads; pass `live: true` to refresh from gh.',
    inputSchema: {
      type: 'object',
      properties: {
        live: {
          type: 'boolean',
          description:
            'Bypass the stack-overview cache and refresh PR/CI data via a batched gh call.',
        },
        pr: {
          type: 'boolean',
          description:
            'Include PR data (default true). Pass false to skip the PR portion entirely.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'dubstack.parent',
    description: 'Return the direct parent for a tracked branch.',
    inputSchema: BRANCH_SCHEMA,
  },
  {
    name: 'dubstack.children',
    description: 'Return direct children for a tracked branch.',
    inputSchema: BRANCH_SCHEMA,
  },
  {
    name: 'dubstack.trunk',
    description: 'Return the trunk/root branch for a tracked branch.',
    inputSchema: BRANCH_SCHEMA,
  },
  {
    name: 'dubstack.history',
    description: 'Return recent Dub command history.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          description: 'Maximum number of history entries to return.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'dubstack.branch',
    description:
      'Return tracked stack metadata for one branch, including parent, children, root, and tree position.',
    inputSchema: BRANCH_SCHEMA,
  },
  {
    name: 'dubstack.diff',
    description:
      'Return a git diff for a branch against its tracked parent, or against an explicit base ref.',
    inputSchema: {
      type: 'object',
      properties: {
        branch: {
          type: 'string',
          description: 'Branch to diff. Defaults to the current branch.',
        },
        base: {
          type: 'string',
          description:
            'Base ref to diff against. Defaults to the branch tracked parent.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'dubstack.ready',
    description:
      'Return a pre-submit readiness checklist for the current branch and chosen submit scope.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['current', 'downstack', 'stack'],
          description: 'Submit scope to check. Defaults to downstack.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'dubstack.merge_check',
    description:
      'Return a mergeability snapshot for one PR, branch, or stack scope.',
    inputSchema: {
      type: 'object',
      properties: {
        pr: {
          type: 'integer',
          minimum: 1,
          description: 'PR number to check.',
        },
        branch: {
          type: 'string',
          description: 'Branch whose PR should be checked.',
        },
        scope: {
          type: 'string',
          enum: ['current', 'downstack', 'stack'],
          description: 'Stack scope to check. Defaults to current.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'dubstack.propose_branch_name',
    description:
      'Use the configured AI provider to suggest a branch name from a diff. Does not mutate git or DubStack state.',
    inputSchema: {
      type: 'object',
      properties: {
        diff: {
          type: 'string',
          description: 'Unified diff or concise change description.',
        },
      },
      required: ['diff'],
      additionalProperties: false,
    },
  },
  {
    name: 'dubstack.propose_commit_message',
    description:
      'Use the configured AI provider to suggest a Conventional Commit message from a diff. Does not mutate git or DubStack state.',
    inputSchema: {
      type: 'object',
      properties: {
        diff: {
          type: 'string',
          description: 'Unified diff or concise change description.',
        },
      },
      required: ['diff'],
      additionalProperties: false,
    },
  },
  {
    name: 'dubstack.propose_pr_description',
    description:
      'Use the configured AI provider to suggest a PR description from branch metadata and a diff. Does not mutate git or DubStack state.',
    inputSchema: {
      type: 'object',
      properties: {
        branch: {
          type: 'string',
          description: 'Branch name for the proposed PR.',
        },
        baseBranch: {
          type: 'string',
          description: 'Base branch for the proposed PR.',
        },
        commitMessage: {
          type: 'string',
          description: 'Commit message or PR title context.',
        },
        diff: {
          type: 'string',
          description: 'Unified diff or concise change description.',
        },
      },
      required: ['branch', 'baseBranch', 'commitMessage', 'diff'],
      additionalProperties: false,
    },
  },
  {
    name: 'dubstack.create',
    description:
      'Create a new branch stacked on top of the current branch, optionally with a commit message.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name of the new branch (omit when using ai).',
        },
        message: {
          type: 'string',
          description: 'Commit message for staged changes on the new branch.',
        },
        ai: {
          type: 'boolean',
          description:
            'AI-generate the branch name and commit from staged changes.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'dubstack.modify',
    description:
      'Amend the current branch tip or create a new commit and restack children.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'New commit message (used for amend or new commit).',
        },
        commit: {
          type: 'boolean',
          description:
            'Create a new commit instead of amending the current tip.',
        },
        all: {
          type: 'boolean',
          description: 'Stage all changes before committing.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'dubstack.submit',
    description:
      'Push branches in the chosen scope and create or update GitHub PRs.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        dryRun: {
          type: 'boolean',
          description:
            'Preview what would happen without pushing or mutating PRs.',
        },
        upstack: {
          type: 'boolean',
          description: 'Submit current branch and all descendants.',
        },
        downstack: {
          type: 'boolean',
          description:
            'Submit current branch and ancestors to trunk (the default).',
        },
        stack: {
          type: 'boolean',
          description: 'Submit the full tree from trunk.',
        },
        branch: {
          type: 'string',
          description: 'Submit only the specified branch.',
        },
        path: {
          type: 'string',
          enum: ['current', 'stack'],
          description:
            "[deprecated] Use 'downstack' (replaces 'current') or 'stack'.",
        },
        fix: {
          type: 'boolean',
          description: '[deprecated] No-op alias retained for compatibility.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'dubstack.sync',
    description:
      'Sync tracked branches with the remote, restack, and prune merged branches.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        force: {
          type: 'boolean',
          description:
            'Skip reset/reconcile prompts and accept deterministic defaults.',
        },
        all: {
          type: 'boolean',
          description: 'Sync all tracked stacks across trunks.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'dubstack.checkout',
    description: 'Switch to a tracked branch (stack-aware).',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        branch: {
          type: 'string',
          description: 'Branch to checkout.',
        },
      },
      required: ['branch'],
      additionalProperties: false,
    },
  },
  {
    name: 'dubstack.back',
    description: 'Return to a previously checked-out branch.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'integer',
          minimum: 1,
          description: 'Number of available history entries to go back.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'dubstack.reorder',
    description:
      "Reorder or drop commits on the current tracked branch. AI clients must supply the full reordered todo (oldest-first) via `entries`; the TUI picker is bypassed. The cascading restack still runs and an undo entry is saved. Returns the resulting status ('success' | 'conflict' | 'exit' | 'cancelled' | 'no-op').",
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        entries: {
          type: 'array',
          description:
            'Ordered rebase todo, oldest commit first. Every commit currently between the parent and HEAD must appear exactly once; mark omissions as `action: "drop"` rather than leaving them out.',
          items: {
            type: 'object',
            properties: {
              sha: {
                type: 'string',
                description:
                  'Full commit SHA (short SHA also accepted but discouraged for AI use).',
              },
              action: {
                type: 'string',
                enum: ['pick', 'drop'],
                description:
                  "'pick' keeps the commit; 'drop' removes it from the branch. No other rebase verbs are supported — use 'dub modify --pop' / 'dub squash' for edit/squash/reword.",
              },
            },
            required: ['sha', 'action'],
            additionalProperties: false,
          },
        },
      },
      required: ['entries'],
      additionalProperties: false,
    },
  },
  {
    name: 'dubstack.freeze',
    description:
      'Set the `frozen` flag on a tracked branch (stack-aware). Note: this is a passive marker only — `dub restack` and `dub sync` do NOT yet honor the flag. The enforcement wiring is tracked as DUB-82.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        branch: {
          type: 'string',
          description: 'Branch to freeze (defaults to the current branch).',
        },
        downstack: {
          type: 'boolean',
          description: 'Also freeze ancestors toward trunk.',
        },
        upstack: {
          type: 'boolean',
          description: 'Also freeze descendants.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'dubstack.unfreeze',
    description:
      'Clear the `frozen` flag on a tracked branch (stack-aware). Note: the flag is a passive marker — `dub restack` and `dub sync` do NOT yet honor it, so clearing the flag has no effect on rebase behavior until DUB-82 lands.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        branch: {
          type: 'string',
          description: 'Branch to unfreeze (defaults to the current branch).',
        },
        downstack: {
          type: 'boolean',
          description: 'Also unfreeze ancestors toward trunk.',
        },
        upstack: {
          type: 'boolean',
          description: 'Also unfreeze descendants.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'dubstack.revert',
    description:
      'Create a branch on trunk that reverts a merged PR or commit and track it as a new stack root.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Merged PR number (e.g. "123") or commit SHA to revert.',
        },
        branch: {
          type: 'string',
          description:
            'Override the auto-generated branch name (default: revert/<source>-<short-sha>).',
        },
        submit: {
          type: 'boolean',
          description:
            'Push the revert branch and open a PR after creating it.',
        },
      },
      required: ['target'],
      additionalProperties: false,
    },
  },
  {
    name: 'dubstack.absorb',
    description:
      'Distribute fixup commits to their targets — autosquash by default, AI-pick targets with `ai`, cross-branch with `stack`.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        ai: {
          type: 'boolean',
          description:
            'AI-pick targets for ambiguous WIP commits on the current branch.',
        },
        stack: {
          type: 'boolean',
          description:
            'Move fixup commits whose target lives on a different branch in the stack.',
        },
        dryRun: {
          type: 'boolean',
          description: 'Preview the plan without mutating.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'dubstack.split',
    description:
      'Split the current branch into smaller sibling branches by commit, file, or AI proposal.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['by-commit', 'by-file', 'ai'],
          description: 'Split mode to run.',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: "Files to extract when mode is 'by-file'.",
        },
        name: {
          type: 'string',
          description: 'New branch name for by-file, by-commit, or by-hunk.',
        },
        commitPicks: {
          type: 'array',
          items: { type: 'integer', minimum: 1 },
          description:
            "1-indexed commit positions to extract when mode is 'by-commit'.",
        },
        commitPicksRaw: {
          type: 'string',
          description:
            "Raw commit selection such as '1,3-4' when mode is 'by-commit'.",
        },
        closeOldPr: {
          type: 'boolean',
          description: "Close the source branch's existing PR.",
        },
        noRestack: {
          type: 'boolean',
          description: 'Skip automatic descendant restack after split.',
        },
        dryRun: {
          type: 'boolean',
          description: 'AI mode only: return the proposal without applying it.',
        },
        yes: {
          type: 'boolean',
          description: 'AI mode only: approve the generated split proposal.',
        },
      },
      required: ['mode'],
      additionalProperties: false,
    },
  },
  {
    name: 'dubstack.squash',
    description:
      'Collapse every commit on the current branch since its parent into one commit.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'Commit message for the squashed commit.',
        },
        ai: {
          type: 'boolean',
          description:
            'Generate a Conventional Commit message from the squashed commits.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'dubstack.fold',
    description:
      'Combine the current branch into its parent and delete the folded branch.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        squash: {
          type: 'boolean',
          description: 'Collapse the folded branch into one parent commit.',
        },
        force: {
          type: 'boolean',
          description:
            'Skip the command confirmation prompt. Defaults to true for MCP because MCP mode already gates mutation.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'dubstack.pop',
    description:
      'Pop the last commit(s) off the current branch into the staging area.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'integer',
          minimum: 1,
          description: 'Number of commits to pop. Defaults to 1.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'dubstack.rename',
    description:
      'Rename a tracked branch and propagate the change through state, children, and remote branch pushes.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        oldName: {
          type: 'string',
          description:
            'Branch to rename. Defaults to the current branch when omitted.',
        },
        newName: {
          type: 'string',
          description: 'New branch name.',
        },
        noPush: {
          type: 'boolean',
          description: 'Skip pushing the renamed branch even if a PR exists.',
        },
      },
      required: ['newName'],
      additionalProperties: false,
    },
  },
  {
    name: 'dubstack.move',
    description:
      'Move a tracked branch before or after another branch in the same stack.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        branch: {
          type: 'string',
          description: 'Branch to move.',
        },
        before: {
          type: 'string',
          description: 'Insert branch as the new parent of this target.',
        },
        after: {
          type: 'string',
          description: 'Insert branch as the new child of this target.',
        },
      },
      required: ['branch'],
      additionalProperties: false,
    },
  },
  {
    name: 'dubstack.unlink',
    description:
      'Detach a tracked branch from its parent and promote it to the root of a new stack (no git branches are deleted).',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        branch: {
          type: 'string',
          description: 'Tracked branch to detach.',
        },
        noRetarget: {
          type: 'boolean',
          description:
            'Skip retargeting the PR base to trunk and warn that the PR will be out of sync.',
        },
        orphanChildren: {
          type: 'boolean',
          description:
            'Re-parent direct children onto the original parent instead of moving them with <branch>.',
        },
      },
      required: ['branch'],
      additionalProperties: false,
    },
  },
  {
    name: 'dubstack.delete',
    description:
      'Delete a local branch and update DubStack metadata (stack-aware).',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        branch: {
          type: 'string',
          description: 'Branch to delete (defaults to current branch).',
        },
        upstack: {
          type: 'boolean',
          description: 'Also delete descendants of the target branch.',
        },
        downstack: {
          type: 'boolean',
          description: 'Also delete ancestors toward trunk.',
        },
        force: {
          type: 'boolean',
          description: 'Delete branches even when not fully merged.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'dubstack.stash',
    description:
      'Capture the working tree (staged + unstaged + untracked) as a branch-aware stash recorded in .git/dubstack/stash-log.json.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description:
            'Override the default stash message (default: branch + timestamp).',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'dubstack.stash-pop',
    description:
      'Pop the most recent dub stash. Refuses if the recorded source branch differs from the current branch unless `on` or `force` is given.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        on: {
          type: 'string',
          description: 'Checkout this branch first, then pop the stash.',
        },
        force: {
          type: 'boolean',
          description:
            "Pop onto the current branch even if it doesn't match the recorded branch.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'dubstack.stash-list',
    description:
      'List recorded dub stashes with branch context and presence in `git stash list`.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
];

export async function mcp(
  cwd: string,
  options: McpServerOptions = {},
): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const serverVersion = options.version ?? '0.0.0';
  const confirmMutating = options.confirmMutating ?? confirmMutatingTool;
  const aiMetadataDeps = options.aiMetadataDeps ?? DEFAULT_AI_METADATA_DEPS;
  let buffer = '';
  let queue: Promise<void> = Promise.resolve();

  input.setEncoding('utf8');

  await new Promise<void>((resolve) => {
    const enqueue = (line: string) => {
      queue = queue
        .catch(() => undefined)
        .then(() =>
          handleLineSafely(
            line,
            cwd,
            output,
            serverVersion,
            confirmMutating,
            aiMetadataDeps,
          ),
        );
    };

    input.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        enqueue(line);
      }
    });

    input.on('end', () => {
      if (buffer.trim().length > 0) {
        enqueue(buffer);
      }
      void queue.then(resolve, resolve);
    });
  });
}

async function handleLineSafely(
  line: string,
  cwd: string,
  output: Writable,
  serverVersion: string,
  confirmMutating: ConfirmMutatingFn,
  aiMetadataDeps: AiMetadataDependencies,
): Promise<void> {
  try {
    await handleLine(
      line,
      cwd,
      output,
      serverVersion,
      confirmMutating,
      aiMetadataDeps,
    );
  } catch (error) {
    const requestId = parseRequestId(line);
    const message = error instanceof Error ? error.message : String(error);
    safeWriteMessage(
      output,
      jsonRpcError(requestId, -32603, `Internal error: ${message}`),
    );
  }
}

async function handleLine(
  line: string,
  cwd: string,
  output: Writable,
  serverVersion: string,
  confirmMutating: ConfirmMutatingFn,
  aiMetadataDeps: AiMetadataDependencies,
): Promise<void> {
  const trimmed = line.trim();
  if (!trimmed) return;

  let message: unknown;
  try {
    message = JSON.parse(trimmed);
  } catch {
    writeMessage(output, jsonRpcError(null, -32700, 'Parse error'));
    return;
  }

  if (!isJsonRpcRequest(message)) {
    writeMessage(output, jsonRpcError(null, -32600, 'Invalid Request'));
    return;
  }

  if (message.id === undefined) {
    await handleNotification(message);
    return;
  }

  const response = await handleRequest(
    message,
    cwd,
    serverVersion,
    confirmMutating,
    aiMetadataDeps,
  );
  writeMessage(output, response);
}

async function handleNotification(request: JsonRpcRequest): Promise<void> {
  if (request.method === 'notifications/initialized') {
    return;
  }
}

async function handleRequest(
  request: JsonRpcRequest,
  cwd: string,
  serverVersion: string,
  confirmMutating: ConfirmMutatingFn,
  aiMetadataDeps: AiMetadataDependencies,
): Promise<JsonValue> {
  switch (request.method) {
    case 'initialize':
      return jsonRpcResult(
        request.id ?? null,
        initializeResult(request, serverVersion),
      );
    case 'ping':
      return jsonRpcResult(request.id ?? null, {});
    case 'tools/list':
      return jsonRpcResult(request.id ?? null, { tools: TOOLS });
    case 'tools/call':
      return handleToolCallRequest(
        request,
        cwd,
        confirmMutating,
        aiMetadataDeps,
      );
    default:
      return jsonRpcError(
        request.id ?? null,
        -32601,
        `Method not found: ${request.method}`,
      );
  }
}

async function handleToolCallRequest(
  request: JsonRpcRequest,
  cwd: string,
  confirmMutating: ConfirmMutatingFn,
  aiMetadataDeps: AiMetadataDependencies,
): Promise<JsonValue> {
  const params = asRecord(request.params);
  const name = typeof params?.name === 'string' ? params.name : null;
  const args = asRecord(params?.arguments) ?? {};

  if (!name) {
    return jsonRpcError(request.id ?? null, -32602, 'Missing tool name.');
  }

  const tool = TOOLS.find((entry) => entry.name === name);
  if (!tool) {
    await appendMcpHistory(cwd, name, args, Date.now(), 'error', [
      `Unknown MCP tool '${name}'.`,
    ]);
    return jsonRpcError(request.id ?? null, -32602, `Unknown tool: ${name}`);
  }

  const startedAt = Date.now();

  if (tool.mutating) {
    const mode = await resolveMcpMode(cwd);

    if (mode === 'read-only') {
      const text = `${name} refused: repo is in read-only MCP mode. Run \`dub config mcp-mode interactive\` to enable mutating tools.`;
      await appendMcpHistory(cwd, name, args, startedAt, 'error', [text], true);
      return jsonRpcResult(request.id ?? null, {
        content: [{ type: 'text', text }],
        isError: true,
      });
    }

    if (mode === 'interactive') {
      const confirmation = await confirmMutating(name, args);
      if (!confirmation.confirmed) {
        await appendMcpHistory(
          cwd,
          name,
          args,
          startedAt,
          'error',
          [confirmation.reason],
          true,
        );
        return jsonRpcResult(request.id ?? null, {
          content: [{ type: 'text', text: confirmation.reason }],
          isError: true,
        });
      }
    }
  }

  try {
    const result = await callTool(cwd, name, args, aiMetadataDeps);
    await appendMcpHistory(
      cwd,
      name,
      args,
      startedAt,
      'success',
      [`MCP tool '${name}' returned structured JSON.`],
      tool.mutating === true,
    );
    return jsonRpcResult(request.id ?? null, result);
  } catch (error) {
    const message =
      error instanceof DubError
        ? formatDubError(error)
        : error instanceof Error
          ? error.message
          : String(error);
    await appendMcpHistory(
      cwd,
      name,
      args,
      startedAt,
      'error',
      [message],
      tool.mutating === true,
    );
    return jsonRpcResult(request.id ?? null, {
      content: [{ type: 'text', text: message }],
      isError: true,
    });
  }
}

async function resolveMcpMode(cwd: string): Promise<McpMode> {
  try {
    const config = await readConfig(cwd);
    return config.mcpMode;
  } catch {
    return 'interactive';
  }
}

async function confirmMutatingTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ConfirmationResult> {
  let fd: number;
  try {
    fd = fs.openSync('/dev/tty', 'r+');
  } catch {
    return {
      confirmed: false,
      reason: `${name} refused: no controlling terminal available for interactive confirmation. Run \`dub config mcp-mode trusted\` to skip prompts, or \`dub config mcp-mode read-only\` to disable mutating tools.`,
    };
  }

  const input = fs.createReadStream('', { fd, autoClose: false });
  const output = fs.createWriteStream('', { fd, autoClose: false });
  const rl = readline.createInterface({ input, output });

  try {
    const summary = formatArgsForPrompt(args);
    const prompt = summary
      ? `\n[dub mcp] Allow ${name} ${summary}? [y/N] `
      : `\n[dub mcp] Allow ${name}? [y/N] `;
    const answer = await rl.question(prompt);
    const normalized = answer.trim().toLowerCase();
    const confirmed = normalized === 'y' || normalized === 'yes';
    return {
      confirmed,
      reason: confirmed
        ? `${name} confirmed by user.`
        : `${name} refused: user declined interactive confirmation.`,
    };
  } finally {
    rl.close();
    // Destroy the streams to release their internal buffers and listeners;
    // autoClose: false means destroy() leaves the underlying fd open for us
    // to close explicitly below.
    input.destroy();
    output.destroy();
    try {
      fs.closeSync(fd);
    } catch {
      // Ignore close errors; the descriptor may already be closed by readline.
    }
  }
}

function formatArgsForPrompt(args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  if (keys.length === 0) return '';
  const parts = keys.map((key) => `${key}=${JSON.stringify(args[key])}`);
  return `(${parts.join(', ')})`;
}

async function callTool(
  cwd: string,
  name: string,
  args: Record<string, unknown>,
  aiMetadataDeps: AiMetadataDependencies,
): Promise<ToolCallResult> {
  switch (name) {
    case 'dubstack.log': {
      const refresh = optionalBoolean(args.refresh);
      // Fail-soft on gh auth / network errors: the structured response should
      // still surface the tracked tree when the overview can't be fetched.
      let overview = null;
      try {
        overview = await getStackOverviewBatch(cwd, { refresh });
      } catch {
        overview = null;
      }
      return jsonToolResult(
        await logJson(cwd, {
          stack: optionalBoolean(args.stack),
          all: optionalBoolean(args.all),
          reverse: optionalBoolean(args.reverse),
          prs: optionalBoolean(args.prs),
          ci: optionalBoolean(args.ci),
          overview,
        }),
      );
    }
    case 'dubstack.doctor':
      return jsonToolResult(
        await doctor(cwd, {
          all: optionalBoolean(args.all),
          fetch: optionalBoolean(args.fetch),
        }),
      );
    case 'dubstack.status':
      return jsonToolResult(
        await status(cwd, {
          live: optionalBoolean(args.live),
          pr: optionalBoolean(args.pr),
        }),
      );
    case 'dubstack.parent':
      return jsonToolResult(await parent(cwd, optionalString(args.branch)));
    case 'dubstack.children':
      return jsonToolResult(await children(cwd, optionalString(args.branch)));
    case 'dubstack.trunk':
      return jsonToolResult(await trunk(cwd, optionalString(args.branch)));
    case 'dubstack.history':
      return jsonToolResult(
        await history(cwd, {
          limit: optionalPositiveInteger(args.limit) ?? 20,
        }),
      );
    case 'dubstack.branch':
      return jsonToolResult(await branchInfo(cwd, optionalString(args.branch)));
    case 'dubstack.diff':
      return jsonToolResult(await diffTool(cwd, args));
    case 'dubstack.ready':
      return jsonToolResult(
        await ready(cwd, { scope: optionalScopeMode(args.scope) }),
      );
    case 'dubstack.merge_check':
      return jsonToolResult(await mergeCheckTool(cwd, args));
    case 'dubstack.propose_branch_name':
    case 'dubstack.propose_commit_message':
      return jsonToolResult(
        await proposeCreateMetadataTool(cwd, name, args, aiMetadataDeps),
      );
    case 'dubstack.propose_pr_description':
      return jsonToolResult(
        await proposePrDescriptionTool(cwd, args, aiMetadataDeps),
      );
    case 'dubstack.create':
      return mutatingToolResult(() =>
        create(optionalString(args.name), cwd, {
          message: optionalString(args.message),
          ai: optionalBoolean(args.ai),
        }),
      );
    case 'dubstack.modify':
      return mutatingToolResult(async () => {
        await modify(cwd, {
          message: optionalString(args.message),
          commit: optionalBoolean(args.commit),
          all: optionalBoolean(args.all),
        });
        return { ok: true };
      });
    case 'dubstack.submit':
      return mutatingToolResult(() =>
        submit(cwd, optionalBoolean(args.dryRun) ?? false, {
          upstack: optionalBoolean(args.upstack),
          downstack: optionalBoolean(args.downstack),
          stack: optionalBoolean(args.stack),
          branch: optionalString(args.branch),
          path: optionalSubmitPath(args.path),
          fix: optionalBoolean(args.fix) ?? false,
        }),
      );
    case 'dubstack.sync':
      return mutatingToolResult(() =>
        sync(cwd, {
          force: optionalBoolean(args.force),
          all: optionalBoolean(args.all),
          interactive: false,
        }),
      );
    case 'dubstack.checkout': {
      const branch = optionalString(args.branch);
      if (!branch) {
        throw new DubError("'branch' is required for dubstack.checkout.", [
          "Pass {'branch': '<name>'} in the tool arguments.",
          'Call dubstack.list-stacks to discover tracked branch names.',
        ]);
      }
      return mutatingToolResult(() => checkout(branch, cwd));
    }
    case 'dubstack.back':
      return mutatingToolResult(() =>
        back(cwd, optionalPositiveInteger(args.steps) ?? 1),
      );
    case 'dubstack.reorder': {
      const entries = parseReorderEntries(args.entries);
      return mutatingToolResult(
        async () =>
          reorder(cwd, {
            entries,
            // Non-TTY contexts can't surface the three-option conflict
            // prompt; resolve to "continue" so the rebase pauses for
            // manual resolution. We flag the response as an error below
            // so the AI client knows the repo is mid-rebase.
            promptConflict: async () => 'continue',
          }),
        {
          // Conflict/exit leaves an interactive rebase mid-flight; surface
          // that as a tool error so AI clients see the repo state isn't
          // clean and can prompt the human for manual recovery.
          isError: (result) =>
            result.status === 'conflict' || result.status === 'exit',
        },
      );
    }
    case 'dubstack.revert': {
      const target = optionalString(args.target);
      if (!target) {
        throw new DubError("'target' is required for dubstack.revert.", [
          "Pass {'target': '<pr-number-or-sha>'} in the tool arguments.",
        ]);
      }
      if (optionalBoolean(args.editMessage)) {
        // `git revert --edit` opens an interactive editor and would deadlock
        // the MCP server — its stdio capture can't proxy a TTY.
        throw new DubError(
          "'editMessage' is not supported via the MCP tool — it requires a TTY.",
          [
            "Run 'dub revert --edit-message <target>' from a terminal instead.",
            "Drop 'editMessage' from the MCP call to use --no-edit.",
          ],
        );
      }
      return mutatingToolResult(() =>
        revert(cwd, target, {
          branchName: optionalString(args.branch),
          submit: optionalBoolean(args.submit),
        }),
      );
    }
    case 'dubstack.delete':
      return mutatingToolResult(() =>
        deleteCommand(cwd, optionalString(args.branch), {
          upstack: optionalBoolean(args.upstack),
          downstack: optionalBoolean(args.downstack),
          force: optionalBoolean(args.force),
          quiet: true,
          interactive: false,
        }),
      );
    case 'dubstack.unlink': {
      const target = optionalString(args.branch);
      if (!target) {
        throw new DubError("'branch' is required for dubstack.unlink.", [
          "Pass {'branch': '<name>'} in the tool arguments.",
          'Call dubstack.log to discover tracked branch names.',
        ]);
      }
      return mutatingToolResult(() =>
        unlink(cwd, target, {
          noRetarget: optionalBoolean(args.noRetarget),
          orphanChildren: optionalBoolean(args.orphanChildren),
        }),
      );
    }
    case 'dubstack.stash':
      return mutatingToolResult(() =>
        stashPush(cwd, { message: optionalString(args.message) }),
      );
    case 'dubstack.stash-pop':
      return mutatingToolResult(() =>
        stashPop(cwd, {
          on: optionalString(args.on),
          force: optionalBoolean(args.force),
        }),
      );
    case 'dubstack.stash-list':
      return jsonToolResult(await stashList(cwd));
    case 'dubstack.freeze':
      return mutatingToolResult(() =>
        freeze(cwd, optionalString(args.branch), {
          upstack: optionalBoolean(args.upstack),
          downstack: optionalBoolean(args.downstack),
        }),
      );
    case 'dubstack.unfreeze':
      return mutatingToolResult(() =>
        unfreeze(cwd, optionalString(args.branch), {
          upstack: optionalBoolean(args.upstack),
          downstack: optionalBoolean(args.downstack),
        }),
      );
    case 'dubstack.absorb':
      return mutatingToolResult(() =>
        absorb(cwd, {
          ai: optionalBoolean(args.ai),
          stack: optionalBoolean(args.stack),
          dryRun: optionalBoolean(args.dryRun),
          interactive: false,
          quiet: true,
        }),
      );
    case 'dubstack.split': {
      const mode = optionalSplitMode(args.mode);
      if (!mode) {
        throw new DubError("'mode' is required for dubstack.split.", [
          "Pass {'mode': 'by-file' | 'by-commit' | 'by-hunk' | 'ai'}.",
        ]);
      }
      if (mode === 'by-hunk') {
        throw new DubError(
          "'by-hunk' split is not supported via MCP because it requires an interactive patch TTY.",
          [
            "Run 'dub split --by-hunk' from a terminal instead.",
            "Use mode 'by-file' or 'by-commit' for non-interactive MCP splits.",
          ],
        );
      }
      const dryRun = optionalBoolean(args.dryRun);
      const yes = optionalBoolean(args.yes);
      if (mode === 'ai' && !dryRun && !yes) {
        throw new DubError(
          "'ai' split requires explicit approval via {'yes': true} when called through MCP.",
          [
            "Call dubstack.split with {'mode': 'ai', 'dryRun': true} first to inspect the proposal.",
            "Call dubstack.split with {'mode': 'ai', 'yes': true} to apply the generated proposal.",
          ],
        );
      }
      return mutatingToolResult(() =>
        split(cwd, {
          mode,
          files: optionalStringArray(args.files),
          name: optionalString(args.name),
          commitPicks: optionalPositiveIntegerArray(args.commitPicks),
          commitPicksRaw: optionalString(args.commitPicksRaw),
          closeOldPr: optionalBoolean(args.closeOldPr),
          noRestack: optionalBoolean(args.noRestack),
          dryRun,
          yes,
          interactive: false,
        }),
      );
    }
    case 'dubstack.squash':
      return mutatingToolResult(() =>
        squash(cwd, {
          message: optionalString(args.message),
          ai: optionalBoolean(args.ai),
        }),
      );
    case 'dubstack.fold':
      return mutatingToolResult(() =>
        fold(cwd, {
          squash: optionalBoolean(args.squash),
          force: optionalBoolean(args.force) ?? true,
          interactive: false,
        }),
      );
    case 'dubstack.pop':
      return mutatingToolResult(() =>
        pop(cwd, { steps: optionalPositiveInteger(args.steps) }),
      );
    case 'dubstack.rename': {
      const newName = optionalString(args.newName);
      if (!newName) {
        throw new DubError("'newName' is required for dubstack.rename.", [
          "Pass {'newName': '<new-branch-name>'} in the tool arguments.",
        ]);
      }
      const oldName = optionalString(args.oldName);
      return mutatingToolResult(() =>
        rename(cwd, oldName ?? newName, oldName ? newName : undefined, {
          noPush: optionalBoolean(args.noPush),
        }),
      );
    }
    case 'dubstack.move': {
      const branch = optionalString(args.branch);
      if (!branch) {
        throw new DubError("'branch' is required for dubstack.move.", [
          "Pass {'branch': '<name>', 'before': '<target>'} or {'branch': '<name>', 'after': '<target>'}.",
        ]);
      }
      return mutatingToolResult(() =>
        move(cwd, branch, {
          before: optionalString(args.before),
          after: optionalString(args.after),
        }),
      );
    }
    default:
      throw new DubError(`Unknown MCP tool '${name}'.`, [
        'Call tools/list to discover the available dubstack.* tool names.',
        'Confirm the client is talking to a current DubStack MCP server build.',
      ]);
  }
}

async function diffTool(
  cwd: string,
  args: Record<string, unknown>,
): Promise<{ branch: string; base: string; diff: string }> {
  const branch = optionalString(args.branch) ?? (await getCurrentBranch(cwd));
  const explicitBase = optionalString(args.base);
  let base = explicitBase;

  if (!base) {
    const info = await branchInfo(cwd, branch);
    if (!info.parent) {
      throw new DubError(`Could not determine a diff base for '${branch}'.`, [
        "Pass {'base': '<ref>'} to diff against an explicit git ref.",
        "Run 'dub branch info <branch>' to confirm the branch is tracked and has a parent.",
      ]);
    }
    base = info.parent;
  }

  return {
    branch,
    base,
    diff: await getDiffBetween(base, branch, cwd),
  };
}

async function mergeCheckTool(
  cwd: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  try {
    return await mergeCheck(cwd, {
      pr: optionalPositiveInteger(args.pr),
      branch: optionalString(args.branch),
      scope: optionalScopeMode(args.scope),
    });
  } catch (error) {
    if (error instanceof DubError) {
      return {
        ok: false,
        reason: error.message,
        fixes: error.recovery,
      };
    }
    throw error;
  }
}

async function proposeCreateMetadataTool(
  cwd: string,
  name: string,
  args: Record<string, unknown>,
  aiMetadataDeps: AiMetadataDependencies,
): Promise<{ branchName: string } | { commitMessage: string }> {
  const diff = optionalString(args.diff);
  if (!diff) {
    throw new DubError("'diff' is required for AI proposal tools.", [
      "Pass {'diff': '<unified diff or concise change description>'}.",
    ]);
  }

  const config = await readConfig(cwd);
  if (!config.aiAssistantEnabled) {
    throw new DubError('AI assistant is disabled for this repo.', [
      "Run 'dub config ai-assistant on' to enable AI proposal tools.",
      "Use 'dubstack.diff' first if you only need a deterministic read-only inspection.",
    ]);
  }

  const templates = await readMetadataTemplates(cwd);
  const generated = await generateCreateMetadata(
    buildAiDiffContext({ rawDiff: diff }),
    aiMetadataDeps,
    { commitTemplate: templates.commitTemplate },
    config.ai.provider,
  );

  if (name === 'dubstack.propose_branch_name') {
    return { branchName: generated.branch };
  }
  return { commitMessage: generated.message };
}

async function proposePrDescriptionTool(
  cwd: string,
  args: Record<string, unknown>,
  aiMetadataDeps: AiMetadataDependencies,
): Promise<{ prDescription: string }> {
  const branch = optionalString(args.branch);
  const baseBranch = optionalString(args.baseBranch);
  const commitMessage = optionalString(args.commitMessage);
  const diff = optionalString(args.diff);
  if (!branch || !baseBranch || !commitMessage || !diff) {
    throw new DubError(
      "'branch', 'baseBranch', 'commitMessage', and 'diff' are required for dubstack.propose_pr_description.",
      [
        "Pass {'branch': '<branch>', 'baseBranch': '<base>', 'commitMessage': '<message>', 'diff': '<diff>'}.",
      ],
    );
  }

  const config = await readConfig(cwd);
  if (!config.aiAssistantEnabled) {
    throw new DubError('AI assistant is disabled for this repo.', [
      "Run 'dub config ai-assistant on' to enable AI proposal tools.",
      "Use 'dubstack.diff' first if you only need a deterministic read-only inspection.",
    ]);
  }

  const templates = await readMetadataTemplates(cwd);
  const prDescription = await generatePrDescriptionSummary(
    {
      branch,
      baseBranch,
      commitMessage,
      diff: buildAiDiffContext({ rawDiff: diff }),
    },
    aiMetadataDeps,
    { prTemplate: templates.prTemplate },
    config.ai.provider,
  );

  return { prDescription };
}

let stdioCaptureActive = false;

interface MutatingToolResultOptions<T> {
  /**
   * Optional callback to decide whether the tool result represents a
   * recoverable error condition (e.g. a mid-rebase conflict) that the AI
   * client should treat as a failure rather than a success. When it returns
   * `true`, `isError: true` is set on the JSON-RPC response so the client
   * knows to surface the structured result for human intervention.
   */
  isError?: (result: T) => boolean;
}

async function mutatingToolResult<T>(
  fn: () => Promise<T>,
  options: MutatingToolResultOptions<T> = {},
): Promise<ToolCallResult> {
  if (stdioCaptureActive) {
    // The server's per-line queue should already serialize tool calls; this
    // guard is defensive against future callers nesting stdio capture, which
    // would corrupt the saved originals and permanently leak the monkey-patch.
    throw new DubError(
      'Internal error: mutatingToolResult invoked while another capture is active.',
      [
        'This is a DubStack invariant violation — please report it.',
        'File a bug at https://github.com/dubstack/dubstack/issues with the surrounding tool call.',
      ],
    );
  }

  stdioCaptureActive = true;
  const captured: string[] = [];
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  const collect = (chunk: string | Uint8Array): void => {
    const text =
      typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    captured.push(text);
  };

  // Writable.write supports `(chunk, callback)` and `(chunk, encoding, callback)`.
  // Invoke the trailing callback (if any) so callers relying on flush signal don't hang.
  const captureShim = (chunk: string | Uint8Array, ...args: unknown[]) => {
    collect(chunk);
    const callback = args.find((arg) => typeof arg === 'function') as
      | ((error?: Error | null) => void)
      | undefined;
    callback?.(null);
    return true;
  };

  process.stdout.write = captureShim as unknown as typeof process.stdout.write;
  process.stderr.write = captureShim as unknown as typeof process.stderr.write;

  try {
    const value = await fn();
    const structuredContent = toJsonValue({
      result: value,
      output: captured.join(''),
    });
    const isError = options.isError?.(value) === true;
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(structuredContent, null, 2),
        },
      ],
      structuredContent,
      ...(isError ? { isError: true } : {}),
    };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    stdioCaptureActive = false;
  }
}

function optionalSubmitPath(value: unknown): 'current' | 'stack' | undefined {
  if (value === 'current' || value === 'stack') return value;
  return undefined;
}

function initializeResult(
  request: JsonRpcRequest,
  serverVersion: string,
): JsonValue {
  const params = asRecord(request.params);
  const requestedVersion =
    typeof params?.protocolVersion === 'string'
      ? params.protocolVersion
      : undefined;
  const protocolVersion =
    requestedVersion && SUPPORTED_PROTOCOL_VERSIONS.has(requestedVersion)
      ? requestedVersion
      : PROTOCOL_VERSION;

  return {
    protocolVersion,
    capabilities: {
      tools: {
        listChanged: false,
      },
    },
    serverInfo: {
      name: 'dubstack',
      title: 'DubStack',
      version: serverVersion,
      description:
        'DubStack tools for tracked branch stacks. Mutating tools are gated by the configured mcp-mode.',
    },
  };
}

async function appendMcpHistory(
  cwd: string,
  name: string,
  args: Record<string, unknown>,
  startedAt: number,
  status: 'success' | 'error',
  output: string[],
  includeArgHash = false,
): Promise<void> {
  const currentBranch = await getCurrentBranch(cwd).catch(() => undefined);
  const operation = await detectActiveOperation(cwd).catch(() => undefined);
  const argsText = formatHistoryArgs(name, args, includeArgHash);
  const command =
    argsText === null
      ? `dub mcp tools/call ${name}`
      : `dub mcp tools/call ${name} ${argsText}`;

  await appendHistoryEntry(cwd, {
    timestamp: new Date(startedAt).toISOString(),
    command,
    status,
    durationMs: Date.now() - startedAt,
    output,
    errorMessage: status === 'error' ? output.join('\n') : undefined,
    context: {
      currentBranch,
      operation,
    },
  }).catch(() => {
    // MCP responses should not fail because audit history could not be written.
  });
}

function formatHistoryArgs(
  name: string,
  args: Record<string, unknown>,
  includeHash: boolean,
): string | null {
  const keys = includeHash
    ? Object.keys(args).sort()
    : (HISTORY_ARG_KEYS[name] ?? []);
  const filteredArgs: Record<string, unknown> = {};

  for (const key of keys) {
    if (Object.hasOwn(args, key)) {
      filteredArgs[key] = args[key];
    }
  }

  const argsText = JSON.stringify(filteredArgs);
  if (!argsText) return null;
  if (!includeHash && argsText === '{}') return null;

  const redactedArgs = redactSensitiveText(argsText);
  const suffix = includeHash ? ` args_sha256=${hashArgs(redactedArgs)}` : '';
  if (redactedArgs.length <= MAX_HISTORY_ARGS_LENGTH)
    return `${redactedArgs}${suffix}`;

  return `${redactedArgs.slice(0, MAX_HISTORY_ARGS_LENGTH)}...${suffix}`;
}

function hashArgs(redactedArgs: string): string {
  return createHash('sha256').update(redactedArgs).digest('hex').slice(0, 16);
}

function jsonToolResult(value: unknown): ToolCallResult {
  const structuredContent = toJsonValue(value);
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(structuredContent, null, 2),
      },
    ],
    structuredContent,
  };
}

function writeMessage(output: Writable, message: JsonValue): void {
  output.write(`${JSON.stringify(message)}\n`);
}

function safeWriteMessage(output: Writable, message: JsonValue): void {
  try {
    writeMessage(output, message);
  } catch {
    // Nothing useful remains to do if the client stream has already closed.
  }
}

function parseRequestId(line: string): JsonRpcId {
  try {
    const message = JSON.parse(line.trim()) as unknown;
    if (isJsonRpcRequest(message) && message.id !== undefined) {
      return message.id ?? null;
    }
  } catch {
    return null;
  }
  return null;
}

function jsonRpcResult(id: JsonRpcId, result: unknown): JsonValue {
  return toJsonValue({
    jsonrpc: '2.0',
    id,
    result,
  });
}

function jsonRpcError(id: JsonRpcId, code: number, message: string): JsonValue {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
    },
  };
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.jsonrpc === '2.0' && typeof record.method === 'string';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number') return undefined;
  if (!Number.isInteger(value) || value < 1) return undefined;
  return value;
}

function optionalPositiveIntegerArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value.filter(
    (entry): entry is number =>
      typeof entry === 'number' && Number.isInteger(entry) && entry >= 1,
  );
  return entries.length === value.length ? entries : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value.filter(
    (entry): entry is string => typeof entry === 'string' && entry.length > 0,
  );
  return entries.length === value.length ? entries : undefined;
}

function optionalScopeMode(value: unknown): ScopeMode | undefined {
  if (value === 'current' || value === 'downstack' || value === 'stack') {
    return value;
  }
  return undefined;
}

function optionalSplitMode(value: unknown): SplitMode | undefined {
  if (
    value === 'by-commit' ||
    value === 'by-file' ||
    value === 'by-hunk' ||
    value === 'ai'
  ) {
    return value;
  }
  return undefined;
}

/**
 * Validates the `entries` argument of the `dubstack.reorder` tool call and
 * normalises it to a `RebaseTodoEntry[]`. Surfaces a `DubError` with
 * recovery hints when the shape is wrong so AI clients can self-correct.
 *
 * Enforces non-emptiness, >=2 entries (matches `reorder()` which rejects
 * single-commit branches), well-formed shape, no duplicate SHAs, and at
 * least one `pick`. The "every commit between parent and HEAD must appear"
 * invariant is enforced downstream by `reorder()` itself once it can read
 * the actual git state.
 */
function parseReorderEntries(value: unknown): RebaseTodoEntry[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new DubError(
      "'entries' must be a non-empty array of {sha, action} objects.",
      [
        "Pass the full rebase todo, oldest commit first, e.g. [{'sha': '<sha>', 'action': 'pick'}, ...].",
        'Call dubstack.log or git log to discover the commits to reorder.',
      ],
    );
  }
  if (value.length < 2) {
    throw new DubError(
      "'entries' must contain at least 2 commits; dub reorder cannot rewrite a single-commit branch.",
      [
        "Use 'dub modify --pop' to edit a single-commit branch.",
        'Add more commits before invoking dubstack.reorder.',
      ],
    );
  }
  const normalized = value.map((raw, idx) => {
    const entry = asRecord(raw);
    const sha = typeof entry?.sha === 'string' ? entry.sha.trim() : '';
    const action = entry?.action;
    if (sha.length === 0 || (action !== 'pick' && action !== 'drop')) {
      throw new DubError(
        `'entries[${idx}]' is invalid: expected {sha: string, action: 'pick' | 'drop'}.`,
        [
          "Set 'action' to 'pick' (keep) or 'drop' (remove).",
          "Pass the full commit SHA in 'sha'.",
        ],
      );
    }
    return { sha, action } satisfies RebaseTodoEntry;
  });
  const seen = new Set<string>();
  for (const entry of normalized) {
    if (seen.has(entry.sha)) {
      throw new DubError(
        `'entries' contains a duplicate SHA '${entry.sha}'. Each commit may appear only once.`,
        [
          'Remove the duplicate; mark commits to skip with `action: "drop"` instead of repeating them.',
        ],
      );
    }
    seen.add(entry.sha);
  }
  if (normalized.every((e) => e.action === 'drop')) {
    throw new DubError(
      "'entries' marks every commit as 'drop'; the rebase would leave the branch empty.",
      [
        "Keep at least one commit as 'pick' (use 'dub delete' if you really want to remove the branch).",
      ],
    );
  }
  return normalized;
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
