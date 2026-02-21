import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { LanguageModel } from 'ai';
import { createGateway, generateText } from 'ai';
import { readConfig } from '../lib/config';
import { DubError } from '../lib/errors';
import {
  branchExists,
  commitStaged,
  createBranch,
  getCurrentBranch,
  getDiff,
  hasStagedChanges,
  interactiveStage,
  isValidBranchName,
  stageAll,
  stageUpdate,
} from '../lib/git';
import { redactSensitiveText } from '../lib/history';
import { addBranchToStack, ensureState, writeState } from '../lib/state';
import { saveUndoEntry } from '../lib/undo-log';

interface CreateOptions {
  ai?: boolean;
  message?: string;
  all?: boolean;
  update?: boolean;
  patch?: boolean;
}

interface CreateResult {
  branch: string;
  parent: string;
  committed?: string;
}

interface CreateDependencies {
  generateText: typeof generateText;
  createGoogleGenerativeAI: typeof createGoogleGenerativeAI;
  createGateway: typeof createGateway;
}

const DEFAULT_DEPS: CreateDependencies = {
  generateText,
  createGoogleGenerativeAI,
  createGateway,
};

const CONVENTIONAL_COMMIT_RE =
  /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]+\))?!?: .+/;

/**
 * Creates a new branch stacked on top of the current branch.
 *
 * When `-m` is provided, also commits staged changes on the new branch.
 * When `-a/-u/-p` are provided, stages changes first (requires `-m` or `--ai`).
 * When `--ai` is provided, branch + commit message are generated from staged changes.
 *
 * @param name - Name of the new branch to create
 * @param cwd - Working directory (auto-initializes if needed)
 * @param options - Optional create flags
 * @returns The created branch name, its parent, and committed message if applicable
 * @throws {DubError} If branch exists, HEAD is detached, invalid option combos, or nothing to commit
 */
export async function create(
  name: string | undefined,
  cwd: string,
  options?: CreateOptions,
  deps: CreateDependencies = DEFAULT_DEPS,
): Promise<CreateResult> {
  const normalizedOptions = options ?? {};
  const useAi = normalizedOptions.ai ?? false;

  if (
    (normalizedOptions.all ||
      normalizedOptions.update ||
      normalizedOptions.patch) &&
    !normalizedOptions.message &&
    !useAi
  ) {
    throw new DubError(
      "'--all', '--update', and '--patch' require '-m' or '--ai'. Pass a commit message or let AI generate one.",
    );
  }

  if (useAi && normalizedOptions.message) {
    throw new DubError("'--ai' cannot be combined with '-m'.");
  }

  if (!useAi && !name?.trim()) {
    throw new DubError(
      "Branch name is required. Pass '<branch-name>' or use '--ai'.",
    );
  }

  if (useAi && name?.trim()) {
    throw new DubError(
      "Do not pass <branch-name> with '--ai'. It generates branch and commit names from staged changes.",
    );
  }

  const state = await ensureState(cwd);
  const parent = await getCurrentBranch(cwd);
  let branchName = name?.trim();
  let commitMessage = normalizedOptions.message?.trim();

  if (commitMessage || useAi) {
    if (normalizedOptions.patch) {
      await interactiveStage(cwd);
    } else if (normalizedOptions.all) {
      await stageAll(cwd);
    } else if (normalizedOptions.update) {
      await stageUpdate(cwd);
    }

    if (!(await hasStagedChanges(cwd))) {
      const hint =
        normalizedOptions.all ||
        normalizedOptions.update ||
        normalizedOptions.patch
          ? 'No changes to commit.'
          : useAi
            ? "No staged changes. Stage files with 'git add' or use '-a' with '--ai'."
            : "No staged changes. Stage files with 'git add' or use '-a' to stage all.";
      throw new DubError(hint);
    }
  }

  if (useAi) {
    const config = await readConfig(cwd);
    if (!config.aiAssistantEnabled) {
      throw new DubError(
        "AI assistant is disabled for this repo. Enable it with 'dub config ai-assistant on'.",
      );
    }

    const stagedDiff = await getDiff(cwd, true);
    const generated = await generateBranchAndCommitFromAi(stagedDiff, deps);
    branchName = generated.branch;
    commitMessage = generated.message;
  }

  if (!branchName) {
    throw new DubError(
      "Branch name is required. Pass '<branch-name>' or use '--ai'.",
    );
  }

  if (!(await isValidBranchName(branchName, cwd))) {
    throw new DubError(`Branch name '${branchName}' is invalid.`);
  }

  if (await branchExists(branchName, cwd)) {
    throw new DubError(`Branch '${branchName}' already exists.`);
  }

  await saveUndoEntry(
    {
      operation: 'create',
      timestamp: new Date().toISOString(),
      previousBranch: parent,
      previousState: structuredClone(state),
      branchTips: {},
      createdBranches: [branchName],
    },
    cwd,
  );

  await createBranch(branchName, cwd);
  addBranchToStack(state, branchName, parent);
  await writeState(state, cwd);

  if (commitMessage) {
    try {
      await commitStaged(commitMessage, cwd);
    } catch (error) {
      const reason = error instanceof DubError ? error.message : String(error);
      throw new DubError(
        `Branch '${branchName}' was created but commit failed: ${reason}. Run 'dub undo' to clean up.`,
      );
    }
    return { branch: branchName, parent, committed: commitMessage };
  }

  return { branch: branchName, parent };
}

async function generateBranchAndCommitFromAi(
  stagedDiff: string,
  deps: CreateDependencies,
): Promise<{ branch: string; message: string }> {
  const resolved = resolveModel(deps);
  const redactedDiff = redactSensitiveText(stagedDiff).trim();
  const diffForPrompt = truncate(redactedDiff, 12_000);
  const prompt = [
    'Generate a git branch name and conventional commit message from the staged diff.',
    'Return JSON only, exactly like: {"branch":"feat/your-branch","message":"feat: summary"}',
    'Rules:',
    '- branch must be lowercase, slash-delimited, and kebab-case.',
    '- message must be a Conventional Commit subject line.',
    '- keep message under 72 characters when possible.',
    '- do not include markdown fences.',
    '',
    'STAGED_DIFF_START',
    diffForPrompt.length > 0 ? diffForPrompt : '[No textual diff available]',
    'STAGED_DIFF_END',
  ].join('\n');

  const result = await deps.generateText({
    model: resolved.model,
    system:
      'You produce concise git metadata. Output strict JSON only and never add extra commentary.',
    prompt,
  });

  return parseAiCreateResponse(result.text);
}

function resolveModel(deps: CreateDependencies): {
  provider: 'google' | 'gateway';
  model: LanguageModel;
  modelId: string;
} {
  const geminiApiKey = process.env.DUBSTACK_GEMINI_API_KEY?.trim();
  if (geminiApiKey) {
    const google = deps.createGoogleGenerativeAI({ apiKey: geminiApiKey });
    return {
      provider: 'google',
      model: google('gemini-3-flash'),
      modelId: 'gemini-3-flash',
    };
  }

  const gatewayApiKey = process.env.DUBSTACK_AI_GATEWAY_API_KEY?.trim();
  if (gatewayApiKey) {
    const gateway = deps.createGateway({ apiKey: gatewayApiKey });
    return {
      provider: 'gateway',
      model: gateway('google/gemini-3-flash'),
      modelId: 'google/gemini-3-flash',
    };
  }

  throw new DubError(
    "AI assistant requires DUBSTACK_GEMINI_API_KEY or DUBSTACK_AI_GATEWAY_API_KEY. Run 'dub ai env --gemini-key <key>' or 'dub ai env --gateway-key <key>'.",
  );
}

function parseAiCreateResponse(text: string): {
  branch: string;
  message: string;
} {
  const candidate = extractJsonObject(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new DubError(
      "AI assistant returned invalid metadata. Re-run with '--ai' or pass branch/message manually.",
    );
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new DubError(
      "AI assistant returned invalid metadata. Re-run with '--ai' or pass branch/message manually.",
    );
  }

  const rawBranch = getStringValue(parsed, 'branch');
  const rawMessage = getStringValue(parsed, 'message');
  const branch = normalizeBranchName(rawBranch);
  const message = normalizeCommitMessage(rawMessage);

  if (branch.length === 0) {
    throw new DubError('AI assistant generated an empty branch name.');
  }

  if (!CONVENTIONAL_COMMIT_RE.test(message)) {
    throw new DubError(
      "AI assistant generated a non-conventional commit message. Re-run '--ai' or pass '-m' manually.",
    );
  }

  return { branch, message };
}

function getStringValue(source: object, key: string): string {
  const value = (source as Record<string, unknown>)[key];
  if (typeof value !== 'string') {
    throw new DubError(`AI assistant metadata is missing '${key}'.`);
  }
  return value;
}

function normalizeBranchName(value: string): string {
  return value
    .trim()
    .replace(/^`+|`+$/g, '')
    .replace(/^refs\/heads\//, '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9./_-]+/g, '-')
    .replace(/\/+/g, '/')
    .replace(/-+/g, '-')
    .replace(/^\/+|\/+$/g, '')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '');
}

function normalizeCommitMessage(value: string): string {
  return value
    .trim()
    .replace(/^`+|`+$/g, '')
    .replace(/\s+/g, ' ');
}

function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  const withoutFences =
    trimmed.startsWith('```') && trimmed.endsWith('```')
      ? trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
      : trimmed;
  const start = withoutFences.indexOf('{');
  const end = withoutFences.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new DubError(
      "AI assistant returned invalid metadata. Re-run with '--ai' or pass branch/message manually.",
    );
  }
  return withoutFences.slice(start, end + 1);
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n...[truncated]`;
}
