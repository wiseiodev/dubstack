import * as fs from 'node:fs';
import * as path from 'node:path';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { fromIni, fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { createGateway, streamText } from 'ai';
import chalk from 'chalk';
import {
  buildAiProviderOptions,
  type ResolvedAiProvider,
  resolveAdjudicationAiProviders,
  resolveAiProvider,
} from '../lib/ai-provider';
import { readConfig } from '../lib/config';
import type { ConflictContext } from '../lib/conflict-context';
import { gatherConflictContext } from '../lib/conflict-context';
import {
  type ConflictTestCache,
  type ConflictTestResult,
  createConflictTestCache,
  runNearbyTestsForFile,
} from '../lib/conflict-tests';
import type { FileResolution } from '../lib/conflict-ui';
import {
  applyResolution,
  promptAdjudicationChoice,
  promptBatchAction,
  promptFileAction,
  renderBatchPreview,
  showScopeWarning,
  validateResolutionPaths,
} from '../lib/conflict-ui';
import { DubError } from '../lib/errors';
import { execa } from '../lib/exec';
import { abortCommand } from './abort';
import { continueCommand } from './continue';

export interface AiResolveDeps {
  streamText: typeof streamText;
  createGoogleGenerativeAI: typeof createGoogleGenerativeAI;
  createAnthropic?: typeof createAnthropic;
  createGateway: typeof createGateway;
  createAmazonBedrock?: typeof createAmazonBedrock;
  createOpenAI?: typeof createOpenAI;
  createOpenAICompatible?: typeof createOpenAICompatible;
  fromIni?: typeof fromIni;
  fromNodeProviderChain?: typeof fromNodeProviderChain;
  readConfig: typeof readConfig;
  gatherConflictContext: typeof gatherConflictContext;
  renderBatchPreview: typeof renderBatchPreview;
  promptBatchAction: typeof promptBatchAction;
  promptFileAction: typeof promptFileAction;
  applyResolution: typeof applyResolution;
  showScopeWarning: typeof showScopeWarning;
  validateResolutionPaths: typeof validateResolutionPaths;
  continueCommand: typeof continueCommand;
  abortCommand: typeof abortCommand;
  promptAdjudicationChoice: typeof promptAdjudicationChoice;
  runNearbyTestsForFile: typeof runNearbyTestsForFile;
}

const DEFAULT_DEPS: AiResolveDeps = {
  streamText,
  createGoogleGenerativeAI,
  createAnthropic,
  createGateway,
  createAmazonBedrock,
  createOpenAI,
  createOpenAICompatible,
  fromIni,
  fromNodeProviderChain,
  readConfig,
  gatherConflictContext,
  renderBatchPreview,
  promptBatchAction,
  promptFileAction,
  applyResolution,
  showScopeWarning,
  validateResolutionPaths,
  continueCommand,
  abortCommand,
  promptAdjudicationChoice,
  runNearbyTestsForFile,
};

interface AiResolveOptions {
  dryRun?: boolean;
  abort?: boolean;
  adjudicate?: boolean;
}

export async function aiResolve(
  cwd: string,
  options: AiResolveOptions,
  deps: AiResolveDeps = DEFAULT_DEPS,
): Promise<void> {
  const sigintHandler = () => {
    console.log(
      '\nCancelled. Conflict state preserved — resolve manually or re-run `dub ai resolve`.',
    );
    process.exit(130);
  };
  process.on('SIGINT', sigintHandler);

  try {
    if (options.abort) {
      await deps.abortCommand(cwd);
      console.log(chalk.green('Operation aborted.'));
      return;
    }

    const [config, context] = await Promise.all([
      deps.readConfig(cwd),
      deps.gatherConflictContext(cwd),
    ]);

    if (context.conflictedFiles.length === 0) {
      throw new DubError('No conflicted files detected.', [
        "Run 'git status' to confirm whether any conflicts remain.",
        "Run 'dub continue' to resume the active rebase or restack.",
        "Run 'dub abort' to cancel the active operation if you no longer need it.",
      ]);
    }

    if (context.scopeWarning) {
      const proceed = await deps.showScopeWarning(context.scopeWarning);
      if (!proceed) return;
    }

    const adjudicationProviders = resolveAdjudicationAiProviders({
      deps,
      providerConfig: config.ai.provider,
    });
    const shouldAdjudicate =
      options.adjudicate === true ||
      (options.adjudicate !== false && adjudicationProviders.length >= 2);
    const resolved =
      shouldAdjudicate && adjudicationProviders[0]
        ? adjudicationProviders[0]
        : resolveAiProvider({
            deps,
            providerConfig: config.ai.provider,
          });

    if (options.adjudicate === true && adjudicationProviders.length < 2) {
      throw new DubError('AI adjudication requires two configured providers.', [
        "Run 'dub ai setup' to configure another provider.",
        "Run 'dub ai resolve --no-adjudicate' to use the configured provider only.",
      ]);
    }

    const resolutions = shouldAdjudicate
      ? await streamAdjudicatedResolutions(
          cwd,
          context,
          adjudicationProviders as [ResolvedAiProvider, ResolvedAiProvider],
          deps,
          Boolean(options.dryRun),
        )
      : await streamResolutions(context, resolved, deps);

    if (!resolutions) return;

    deps.validateResolutionPaths(resolutions, context.conflictedFiles, cwd);

    if (options.dryRun) {
      deps.renderBatchPreview(sortByConfidence(resolutions));
      console.log(chalk.dim('\nDry run — no changes applied.'));
      return;
    }

    await applyAndContinue(
      cwd,
      context,
      resolutions,
      resolved,
      deps,
      0,
      createConflictTestCache(),
    );
  } finally {
    process.removeListener('SIGINT', sigintHandler);
  }
}

function buildConflictSystemPrompt(): string {
  return [
    'You are an AI assistant helping resolve git merge conflicts.',
    'Analyze the conflict markers and propose a clean resolution for each file.',
    'Output a JSON array of objects with: path, resolvedContent, confidence (high/medium/low), explanation.',
    'Never silently drop changes from either side.',
    'Explain what both sides changed and why in the explanation field.',
    "Flag uncertain resolutions with 'low' confidence.",
    'Return ONLY the JSON array, no markdown fences or extra text.',
  ].join(' ');
}

function buildConflictUserPrompt(
  context: ConflictContext,
  errorFeedback?: string,
): string {
  const sections: string[] = [];

  if (errorFeedback) {
    sections.push(`Previous resolution attempt failed: ${errorFeedback}`);
    sections.push('');
  }

  sections.push(
    `Operation: ${context.operation}`,
    `Branch: ${context.conflictedBranch} (rebasing onto ${context.parentBranch})`,
  );

  if (context.restackStep) {
    sections.push(`Restack step: ${JSON.stringify(context.restackStep)}`);
    if (context.remainingSteps !== undefined) {
      sections.push(`Remaining steps: ${context.remainingSteps}`);
    }
  }

  sections.push(
    '',
    '--- Upstream commits (base being rebased onto) ---',
    context.upstreamCommits || '(none)',
    '',
    '--- Replayed commits (branch being rebased) ---',
    context.replayedCommits || '(none)',
    '',
    '--- Conflicted files with markers ---',
  );

  for (const file of context.conflictedFiles) {
    sections.push(`\n=== ${file} ===`);
    sections.push(context.conflictMarkers[file] ?? '(content unavailable)');
  }

  return sections.join('\n');
}

async function streamResolutions(
  context: ConflictContext,
  resolved: ResolvedAiProvider,
  deps: AiResolveDeps,
  errorFeedback?: string,
): Promise<FileResolution[]> {
  console.log(
    chalk.dim(
      `Analyzing ${context.conflictedFiles.length} conflicted file(s) with ${providerLabel(resolved)}...`,
    ),
  );

  const result = deps.streamText({
    model: resolved.model,
    system: buildConflictSystemPrompt(),
    prompt: buildConflictUserPrompt(context, errorFeedback),
    providerOptions: buildAiProviderOptions(resolved, {
      withWebBrowsing: false,
    }) as never,
  });

  let fullText = '';
  for await (const part of result.fullStream) {
    if (part.type === 'text-delta') {
      fullText += part.text ?? '';
    } else if (part.type === 'error') {
      throw part.error instanceof Error
        ? part.error
        : new DubError('AI stream failed unexpectedly.', [
            "Rerun 'dub continue --ai' to retry the resolution.",
            "Resolve the conflicts manually and run 'dub continue'.",
          ]);
    }
  }

  const resolutions = parseResolutions(fullText);

  for (const res of resolutions) {
    res.originalContent = context.conflictMarkers[res.path] ?? '';
  }

  return resolutions;
}

async function streamAdjudicatedResolutions(
  cwd: string,
  context: ConflictContext,
  providers: [ResolvedAiProvider, ResolvedAiProvider],
  deps: AiResolveDeps,
  dryRun: boolean,
): Promise<FileResolution[] | null> {
  const [firstProvider, secondProvider] = providers;
  console.log(
    chalk.dim(
      `Adjudicating conflicts with ${providerLabel(firstProvider)} and ${providerLabel(secondProvider)}...`,
    ),
  );

  const [first, second] = await Promise.all([
    streamResolutions(context, firstProvider, deps),
    streamResolutions(context, secondProvider, deps),
  ]);
  const byPath = new Map<
    string,
    { first?: FileResolution; second?: FileResolution }
  >();

  for (const res of first) {
    byPath.set(res.path, { ...byPath.get(res.path), first: res });
  }
  for (const res of second) {
    byPath.set(res.path, { ...byPath.get(res.path), second: res });
  }

  const chosen: FileResolution[] = [];
  const disagreements: AdjudicationDisagreement[] = [];
  let skippedFile: string | null = null;

  for (const file of context.conflictedFiles) {
    const pair = byPath.get(file);
    if (!pair?.first || !pair.second) {
      throw new DubError(
        `AI adjudication did not return two resolutions for ${file}.`,
        [
          "Rerun 'dub continue --ai' to retry.",
          "Run 'dub ai resolve --no-adjudicate' to use single-provider mode.",
        ],
      );
    }

    if (pair.first.resolvedContent === pair.second.resolvedContent) {
      chosen.push({
        ...pair.first,
        confidence: 'high',
        explanation: `Both ${providerLabel(firstProvider)} and ${providerLabel(secondProvider)} agreed. ${pair.first.explanation}`,
      });
      continue;
    }

    disagreements.push({
      path: file,
      firstProvider: providerLabel(firstProvider),
      secondProvider: providerLabel(secondProvider),
      first: pair.first,
      second: pair.second,
    });

    console.log(chalk.yellow(`\nAI providers disagreed on ${file}.`));
    deps.renderBatchPreview([
      {
        ...pair.first,
        confidence: 'low',
        explanation: `${providerLabel(firstProvider)}: ${pair.first.explanation}`,
      },
      {
        ...pair.second,
        confidence: 'low',
        explanation: `${providerLabel(secondProvider)}: ${pair.second.explanation}`,
      },
    ]);

    if (dryRun) {
      chosen.push({
        ...pair.first,
        confidence: 'low',
        explanation: `${providerLabel(firstProvider)} shown first for dry-run adjudication disagreement. ${pair.first.explanation}`,
      });
      continue;
    }

    const choice = await deps.promptAdjudicationChoice({
      file,
      firstProvider: providerLabel(firstProvider),
      secondProvider: providerLabel(secondProvider),
    });

    if (choice === 'abort') {
      await deps.abortCommand(cwd);
      console.log(chalk.yellow('Operation aborted.'));
      return null;
    }

    if (choice === 'skip') {
      skippedFile = file;
      break;
    }

    if (choice === 'first') {
      chosen.push({
        ...pair.first,
        confidence: 'low',
        explanation: `${providerLabel(firstProvider)} selected after adjudication disagreement. ${pair.first.explanation}`,
      });
    } else if (choice === 'second') {
      chosen.push({
        ...pair.second,
        confidence: 'low',
        explanation: `${providerLabel(secondProvider)} selected after adjudication disagreement. ${pair.second.explanation}`,
      });
    }
  }

  if (!dryRun && disagreements.length > 0) {
    await logAdjudicationDisagreements(cwd, disagreements);
  }

  if (skippedFile) {
    console.log(
      chalk.yellow(
        `Skipped AI resolution for ${skippedFile}. Conflict state preserved; resolve it manually, then run \`dub continue\`.`,
      ),
    );
    return null;
  }

  return chosen;
}

function parseResolutions(text: string): FileResolution[] {
  let jsonStr = text.trim();

  // Strip markdown code fences if present
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  // Extract JSON array
  const arrayStart = jsonStr.indexOf('[');
  const arrayEnd = jsonStr.lastIndexOf(']');
  if (arrayStart !== -1 && arrayEnd !== -1 && arrayEnd > arrayStart) {
    jsonStr = jsonStr.slice(arrayStart, arrayEnd + 1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new DubError('Could not parse AI response.', [
      "Rerun 'dub continue --ai' to ask the AI again.",
      "Resolve the conflicts manually and run 'dub continue'.",
    ]);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new DubError('AI returned no resolutions.', [
      "Resolve the conflicts manually and run 'dub continue'.",
      "Run 'dub abort' to cancel the active operation.",
    ]);
  }

  return (parsed as unknown[]).map((raw) => {
    if (typeof raw !== 'object' || raw === null) {
      throw new DubError('AI returned an invalid resolution format.', [
        "Rerun 'dub continue --ai' to retry.",
        "Resolve the conflicts manually and run 'dub continue'.",
      ]);
    }
    const item = raw as Record<string, unknown>;
    return {
      path: String(item.path ?? ''),
      originalContent: '',
      resolvedContent: String(item.resolvedContent ?? ''),
      confidence: validateConfidence(item.confidence),
      explanation: String(item.explanation ?? ''),
    };
  });
}

function validateConfidence(value: unknown): 'high' | 'medium' | 'low' {
  if (value === 'high' || value === 'medium' || value === 'low') return value;
  return 'low';
}

async function applyAndContinue(
  cwd: string,
  context: ConflictContext,
  resolutions: FileResolution[],
  resolved: ResolvedAiProvider,
  deps: AiResolveDeps,
  retryCount: number,
  testCache: ConflictTestCache,
): Promise<void> {
  const ordered = sortByConfidence(resolutions);
  deps.renderBatchPreview(ordered);

  const action = await deps.promptBatchAction();

  if (action === 'abort') {
    await deps.abortCommand(cwd);
    console.log(chalk.yellow('Operation aborted.'));
    return;
  }

  if (action === 'apply-all') {
    for (const res of ordered) {
      await applyResolutionWithTestRetry(
        cwd,
        context,
        res,
        resolved,
        deps,
        testCache,
      );
    }
  } else {
    for (const res of ordered) {
      deps.renderBatchPreview([res]);
      const fileAction = await deps.promptFileAction(res.path);

      if (fileAction === 'abort') {
        await deps.abortCommand(cwd);
        console.log(chalk.yellow('Operation aborted.'));
        return;
      }

      if (fileAction === 'apply') {
        await applyResolutionWithTestRetry(
          cwd,
          context,
          res,
          resolved,
          deps,
          testCache,
        );
      }
    }
  }

  try {
    await deps.continueCommand(cwd);
    console.log(
      chalk.green('Conflicts resolved and operation continued successfully.'),
    );
  } catch (err) {
    if (retryCount >= 1) {
      console.log(
        chalk.yellow(
          'AI could not fully resolve the conflicts. Please resolve manually and run `dub continue`.',
        ),
      );
      return;
    }

    try {
      const errMsg =
        err instanceof Error ? err.message : 'Unknown error during continue';
      console.log(chalk.yellow('New conflicts detected. Retrying with AI...'));
      const retryContext = await deps.gatherConflictContext(cwd);
      if (retryContext.conflictedFiles.length === 0) {
        console.log(
          chalk.yellow(
            'AI could not fully resolve the conflicts. Please resolve manually and run `dub continue`.',
          ),
        );
        return;
      }
      const retryResolutions = await streamResolutions(
        retryContext,
        resolved,
        deps,
        errMsg,
      );
      deps.validateResolutionPaths(
        retryResolutions,
        retryContext.conflictedFiles,
        cwd,
      );
      await applyAndContinue(
        cwd,
        retryContext,
        retryResolutions,
        resolved,
        deps,
        retryCount + 1,
        testCache,
      );
    } catch {
      console.log(
        chalk.yellow(
          'AI could not fully resolve the conflicts. Please resolve manually and run `dub continue`.',
        ),
      );
    }
  }
}

async function applyResolutionWithTestRetry(
  cwd: string,
  context: ConflictContext,
  resolution: FileResolution,
  resolved: ResolvedAiProvider,
  deps: AiResolveDeps,
  testCache: ConflictTestCache,
): Promise<void> {
  await deps.applyResolution(resolution.path, resolution.resolvedContent, cwd);

  const testResult = await deps.runNearbyTestsForFile(
    resolution.path,
    cwd,
    testCache,
  );
  if (testResult.status === 'none') return;

  if (testResult.status === 'passed') {
    resolution.confidence = 'high';
    console.log(
      chalk.green(
        `✔ Nearby tests passed for ${resolution.path}: ${testResult.files.join(', ')}`,
      ),
    );
    return;
  }

  resolution.confidence = 'low';
  console.log(
    chalk.yellow(
      `Nearby tests failed for ${resolution.path}. Retrying with test feedback...`,
    ),
  );
  const retryResolutions = await streamResolutions(
    context,
    resolved,
    deps,
    buildTestFailureFeedback(resolution.path, testResult),
  );
  deps.validateResolutionPaths(retryResolutions, context.conflictedFiles, cwd);
  const retry = retryResolutions.find((res) => res.path === resolution.path);
  if (!retry) return;

  retry.confidence = 'low';
  await deps.applyResolution(retry.path, retry.resolvedContent, cwd);
  const retryTestResult = await deps.runNearbyTestsForFile(
    retry.path,
    cwd,
    testCache,
  );
  if (retryTestResult.status === 'passed') {
    retry.confidence = 'high';
    console.log(
      chalk.green(
        `✔ Nearby tests passed for ${retry.path}: ${retryTestResult.files.join(', ')}`,
      ),
    );
    return;
  }

  if (retryTestResult.status === 'failed') {
    throw new DubError(`Nearby tests still fail for ${retry.path}.`, [
      formatTestCommand(retryTestResult),
      retryTestResult.output
        ? `Output:\n${retryTestResult.output}`
        : 'Inspect the failing test output, adjust the resolution, then run `dub continue`.',
    ]);
  }
}

function buildTestFailureFeedback(
  file: string,
  result: ConflictTestResult,
): string {
  return [
    `Tests failed after applying the proposed resolution for ${file}.`,
    formatTestCommand(result),
    result.output ? `Output:\n${result.output}` : undefined,
  ]
    .filter(Boolean)
    .join('\n');
}

function formatTestCommand(result: ConflictTestResult): string {
  if (!result.target)
    return `Command: pnpm vitest run ${result.files.join(' ')}`;
  return [
    `Working directory: ${result.target.cwd}`,
    `Command: pnpm vitest run ${result.target.files.join(' ')}`,
  ].join('\n');
}

function sortByConfidence(resolutions: FileResolution[]): FileResolution[] {
  const rank: Record<FileResolution['confidence'], number> = {
    low: 0,
    medium: 1,
    high: 2,
  };
  return [...resolutions].sort(
    (a, b) => rank[a.confidence] - rank[b.confidence],
  );
}

interface AdjudicationDisagreement {
  path: string;
  firstProvider: string;
  secondProvider: string;
  first: FileResolution;
  second: FileResolution;
}

async function logAdjudicationDisagreements(
  cwd: string,
  disagreements: AdjudicationDisagreement[],
): Promise<void> {
  const gitDir = await resolveGitDir(cwd);
  const bankDir = path.join(gitDir, 'dubstack', 'ai-eval-bank');
  fs.mkdirSync(bankDir, { recursive: true });
  const filename = `${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(
    path.join(bankDir, filename),
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        disagreements: disagreements.map((disagreement) => ({
          path: disagreement.path,
          firstProvider: disagreement.firstProvider,
          secondProvider: disagreement.secondProvider,
          first: {
            confidence: disagreement.first.confidence,
            explanation: disagreement.first.explanation,
            resolvedContent: disagreement.first.resolvedContent,
          },
          second: {
            confidence: disagreement.second.confidence,
            explanation: disagreement.second.explanation,
            resolvedContent: disagreement.second.resolvedContent,
          },
        })),
      },
      null,
      2,
    ),
    'utf-8',
  );
}

async function resolveGitDir(cwd: string): Promise<string> {
  try {
    const { stdout } = await execa('git', ['rev-parse', '--git-dir'], { cwd });
    const gitDir = stdout.trim();
    return path.isAbsolute(gitDir) ? gitDir : path.resolve(cwd, gitDir);
  } catch {
    return path.join(cwd, '.git');
  }
}

function providerLabel(provider: ResolvedAiProvider): string {
  return `${provider.provider}:${provider.modelId}`;
}
