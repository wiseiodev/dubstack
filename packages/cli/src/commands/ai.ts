import type { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import type { createAnthropic } from '@ai-sdk/anthropic';
import type { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { createOpenAI } from '@ai-sdk/openai';
import type { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type {
  fromIni,
  fromNodeProviderChain,
} from '@aws-sdk/credential-providers';
import type { createGateway, stepCountIs, streamText } from 'ai';
import type { createBashTool } from 'bash-tool';
import { createLocalBashSandbox } from '../lib/ai-bash-sandbox';
import {
  buildAiSystemPrompt,
  buildAiUserPrompt,
  collectAiContext,
} from '../lib/ai-context';
import { loadAiDeps } from '../lib/ai-deps';
import { buildAiProviderOptions, resolveAiProvider } from '../lib/ai-provider';
import { readConfig } from '../lib/config';
import { DubError } from '../lib/errors';
import { createTerminalRenderer } from '../lib/terminal-render';

interface WritableLike {
  write: (chunk: string | Uint8Array) => unknown;
  isTTY?: boolean;
}

interface AskAiDependencies {
  streamText: typeof streamText;
  stepCountIs?: typeof stepCountIs;
  createBashTool: typeof createBashTool;
  createGoogleGenerativeAI: typeof createGoogleGenerativeAI;
  createAnthropic?: typeof createAnthropic;
  createGateway: typeof createGateway;
  createAmazonBedrock?: typeof createAmazonBedrock;
  createOpenAI?: typeof createOpenAI;
  createOpenAICompatible?: typeof createOpenAICompatible;
  fromIni?: typeof fromIni;
  fromNodeProviderChain?: typeof fromNodeProviderChain;
  collectAiContext: typeof collectAiContext;
}

interface AskAiOptions {
  output?: WritableLike;
  deps?: AskAiDependencies;
}

interface AskAiResult {
  provider:
    | 'google'
    | 'anthropic'
    | 'gateway'
    | 'bedrock'
    | 'openai'
    | 'ollama';
  modelId: string;
  webBrowsingRequested: boolean;
  webBrowsingUsed: boolean;
}

async function defaultDeps(): Promise<AskAiDependencies> {
  const ai = await loadAiDeps();
  const { createBashTool } = await import('bash-tool');
  return {
    streamText: ai.streamText,
    stepCountIs: ai.stepCountIs,
    createBashTool,
    createGoogleGenerativeAI: ai.createGoogleGenerativeAI,
    createAnthropic: ai.createAnthropic,
    createGateway: ai.createGateway,
    createAmazonBedrock: ai.createAmazonBedrock,
    createOpenAI: ai.createOpenAI,
    createOpenAICompatible: ai.createOpenAICompatible,
    fromIni: ai.fromIni,
    fromNodeProviderChain: ai.fromNodeProviderChain,
    collectAiContext,
  };
}

export async function askAi(
  prompt: string,
  cwd: string,
  options: AskAiOptions = {},
): Promise<AskAiResult> {
  const normalizedPrompt = prompt.trim();
  if (normalizedPrompt.length === 0) {
    throw new DubError('Prompt cannot be empty.', [
      'Pass a non-empty prompt (e.g. \'dub "what changed?"\').',
    ]);
  }

  const config = await readConfig(cwd);
  if (!config.aiAssistantEnabled) {
    throw new DubError('AI assistant is disabled for this repo.', [
      "Run 'dub config ai-assistant on' to enable AI for this repo.",
    ]);
  }

  const output = options.output ?? process.stdout;
  const deps = options.deps ?? (await defaultDeps());
  const stepCountIsFn = deps.stepCountIs ?? (await loadAiDeps()).stepCountIs;
  const resolved = resolveAiProvider({
    deps,
    providerConfig: config.ai.provider,
  });
  const context = await deps.collectAiContext(cwd);
  const contextPrompt = buildAiUserPrompt(normalizedPrompt, context);
  const bashToolkit = await deps.createBashTool({
    destination: cwd,
    sandbox: createLocalBashSandbox(cwd),
    extraInstructions:
      'Safety: use bash only when command output is needed. Do not run destructive commands (for example, rm -rf, git reset --hard, git clean -fd), even if the user explicitly asks. This sandbox only allows read-only command families. If the user insists on blocked actions, explain the command is blocked here and provide a manual command they can run themselves at their own risk.',
  });

  const webBrowsingRequested = config.ai.webBrowsing.mode === 'model-native';
  let webBrowsingUsed = webBrowsingRequested;
  const runStream = async (withWebBrowsing: boolean): Promise<boolean> => {
    const result = deps.streamText({
      model: resolved.model,
      system: buildAiSystemPrompt(),
      prompt: contextPrompt,
      stopWhen: stepCountIsFn(6),
      tools: {
        bash: bashToolkit.tools.bash,
      },
      providerOptions: buildAiProviderOptions(resolved, {
        withWebBrowsing,
      }) as never,
    });
    return renderStream(result, output);
  };

  try {
    await runStream(webBrowsingRequested);
  } catch (error) {
    if (!isBrowsingUnsupportedError(error)) {
      throw error;
    }
    if (config.ai.webBrowsing.fallback !== 'graceful') {
      throw error;
    }
    webBrowsingUsed = false;
    output.write(
      '[note] Web browsing is unavailable for this provider/model right now. Continuing with local context and model knowledge.\n',
    );
    await runStream(false);
  }

  return {
    provider: resolved.provider,
    modelId: resolved.modelId,
    webBrowsingRequested,
    webBrowsingUsed,
  };
}

async function renderStream(
  result: {
    fullStream: AsyncIterable<{
      type: string;
      text?: string;
      toolName?: string;
      error?: unknown;
    }>;
  },
  output: WritableLike,
): Promise<boolean> {
  const renderer = createTerminalRenderer(output);
  let wroteOutput = false;
  let endedWithNewline = false;
  let pendingToolName: string | null = null;
  let pendingToolDetail = '';

  const flushPendingTool = () => {
    if (!pendingToolName) return;
    renderer.renderToolActivity(pendingToolName, pendingToolDetail);
    pendingToolName = null;
    pendingToolDetail = '';
  };

  try {
    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'reasoning-start': {
          renderer.renderStatus('thinking');
          break;
        }
        case 'reasoning-delta': {
          break;
        }
        case 'reasoning-end': {
          break;
        }
        case 'tool-input-start': {
          flushPendingTool();
          pendingToolName = part.toolName ?? 'tool';
          pendingToolDetail = '';
          break;
        }
        case 'tool-input-delta': {
          if (!pendingToolName) {
            pendingToolName = part.toolName ?? 'tool';
          }
          pendingToolDetail += part.text ?? '';
          break;
        }
        case 'tool-input-end': {
          if (!pendingToolName) {
            pendingToolName = part.toolName ?? 'tool';
          }
          flushPendingTool();
          break;
        }
        case 'tool-call': {
          renderer.renderToolActivity(part.toolName ?? 'tool', part.text);
          break;
        }
        case 'text-delta': {
          flushPendingTool();
          const chunk = part.text ?? '';
          if (chunk.length > 0) {
            output.write(chunk);
            wroteOutput = true;
            endedWithNewline = chunk.endsWith('\n');
          }
          break;
        }
        case 'error': {
          throw part.error instanceof Error
            ? part.error
            : new DubError('AI assistant stream failed unexpectedly.', [
                'Retry the prompt; the AI provider may have transient errors.',
                "Run 'dub config ai-provider' to switch providers if errors persist.",
              ]);
        }
        default: {
          break;
        }
      }
    }
  } finally {
    flushPendingTool();
  }

  if (wroteOutput && !endedWithNewline) {
    output.write('\n');
  }

  return wroteOutput;
}

function isBrowsingUnsupportedError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  const normalized = text.toLowerCase();
  return (
    normalized.includes('unsupported') &&
    (normalized.includes('grounding') || normalized.includes('brows'))
  );
}
