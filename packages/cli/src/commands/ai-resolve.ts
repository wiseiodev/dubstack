import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { fromIni, fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { createGateway, streamText } from 'ai';
import chalk from 'chalk';
import { buildAiProviderOptions, resolveAiProvider } from '../lib/ai-provider';
import { readConfig } from '../lib/config';
import type { ConflictContext } from '../lib/conflict-context';
import { gatherConflictContext } from '../lib/conflict-context';
import type { FileResolution } from '../lib/conflict-ui';
import {
  applyResolution,
  promptBatchAction,
  promptFileAction,
  renderBatchPreview,
  showScopeWarning,
  validateResolutionPaths,
} from '../lib/conflict-ui';
import { DubError } from '../lib/errors';
import { abortCommand } from './abort';
import { continueCommand } from './continue';

export interface AiResolveDeps {
  streamText: typeof streamText;
  createGoogleGenerativeAI: typeof createGoogleGenerativeAI;
  createGateway: typeof createGateway;
  createAmazonBedrock?: typeof createAmazonBedrock;
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
}

const DEFAULT_DEPS: AiResolveDeps = {
  streamText,
  createGoogleGenerativeAI,
  createGateway,
  createAmazonBedrock,
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
};

export async function aiResolve(
  cwd: string,
  options: { dryRun?: boolean; abort?: boolean },
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
      throw new DubError('No conflicted files detected.');
    }

    if (context.scopeWarning) {
      const proceed = await deps.showScopeWarning(context.scopeWarning);
      if (!proceed) return;
    }

    const resolved = resolveAiProvider({
      deps,
      providerConfig: config.ai.provider,
    });
    const resolutions = await streamResolutions(context, resolved, deps);

    deps.validateResolutionPaths(resolutions, context.conflictedFiles, cwd);

    if (options.dryRun) {
      deps.renderBatchPreview(resolutions);
      console.log(chalk.dim('\nDry run — no changes applied.'));
      return;
    }

    await applyAndContinue(cwd, resolutions, resolved, deps, 0);
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
  resolved: ReturnType<typeof resolveAiProvider>,
  deps: AiResolveDeps,
  errorFeedback?: string,
): Promise<FileResolution[]> {
  console.log(
    chalk.dim(
      `Analyzing ${context.conflictedFiles.length} conflicted file(s)...`,
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
        : new DubError('AI stream failed unexpectedly.');
    }
  }

  const resolutions = parseResolutions(fullText);

  for (const res of resolutions) {
    res.originalContent = context.conflictMarkers[res.path] ?? '';
  }

  return resolutions;
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
    throw new DubError(
      'Could not parse AI response. Try again or resolve conflicts manually.',
    );
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new DubError(
      'AI returned no resolutions. Resolve conflicts manually.',
    );
  }

  return (parsed as unknown[]).map((raw) => {
    if (typeof raw !== 'object' || raw === null) {
      throw new DubError(
        'AI returned an invalid resolution format. Resolve conflicts manually.',
      );
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
  resolutions: FileResolution[],
  resolved: ReturnType<typeof resolveAiProvider>,
  deps: AiResolveDeps,
  retryCount: number,
): Promise<void> {
  deps.renderBatchPreview(resolutions);

  const action = await deps.promptBatchAction();

  if (action === 'abort') {
    await deps.abortCommand(cwd);
    console.log(chalk.yellow('Operation aborted.'));
    return;
  }

  if (action === 'apply-all') {
    for (const res of resolutions) {
      await deps.applyResolution(res.path, res.resolvedContent, cwd);
    }
  } else {
    for (const res of resolutions) {
      deps.renderBatchPreview([res]);
      const fileAction = await deps.promptFileAction(res.path);

      if (fileAction === 'abort') {
        await deps.abortCommand(cwd);
        console.log(chalk.yellow('Operation aborted.'));
        return;
      }

      if (fileAction === 'apply') {
        await deps.applyResolution(res.path, res.resolvedContent, cwd);
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
        retryResolutions,
        resolved,
        deps,
        retryCount + 1,
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
