import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { LanguageModel } from 'ai';
import { createGateway, stepCountIs, streamText } from 'ai';
import { createBashTool } from 'bash-tool';
import { createLocalBashSandbox } from '../lib/ai-bash-sandbox';
import {
  buildAiSystemPrompt,
  buildAiUserPrompt,
  collectAiContext,
} from '../lib/ai-context';
import { readConfig } from '../lib/config';
import { DubError } from '../lib/errors';

interface WritableLike {
  write: (chunk: string | Uint8Array) => unknown;
  isTTY?: boolean;
}

interface AskAiDependencies {
  streamText: typeof streamText;
  createBashTool: typeof createBashTool;
  createGoogleGenerativeAI: typeof createGoogleGenerativeAI;
  createGateway: typeof createGateway;
  collectAiContext: typeof collectAiContext;
}

interface AskAiOptions {
  output?: WritableLike;
  deps?: AskAiDependencies;
}

interface AskAiResult {
  provider: 'google' | 'gateway';
  modelId: string;
  webBrowsingRequested: boolean;
  webBrowsingUsed: boolean;
}

const DEFAULT_DEPS: AskAiDependencies = {
  streamText,
  createBashTool,
  createGoogleGenerativeAI,
  createGateway,
  collectAiContext,
};

const THINKING_PROVIDER_OPTIONS = {
  google: {
    thinkingConfig: {
      thinkingLevel: 'high' as const,
      includeThoughts: true,
    },
  },
} as const;

const SPINNER_FRAMES = ['-', '\\', '|', '/'] as const;

export async function askAi(
  prompt: string,
  cwd: string,
  options: AskAiOptions = {},
): Promise<AskAiResult> {
  const normalizedPrompt = prompt.trim();
  if (normalizedPrompt.length === 0) {
    throw new DubError('Prompt cannot be empty.');
  }

  const config = await readConfig(cwd);
  if (!config.aiAssistantEnabled) {
    throw new DubError(
      "AI assistant is disabled for this repo. Enable it with 'dub config ai-assistant on'.",
    );
  }

  const output = options.output ?? process.stdout;
  const deps = options.deps ?? DEFAULT_DEPS;
  const resolved = resolveModel(deps);
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
  let wroteOutput = false;
  const runStream = async (withWebBrowsing: boolean): Promise<boolean> => {
    const result = deps.streamText({
      model: resolved.model,
      system: buildAiSystemPrompt(),
      prompt: contextPrompt,
      stopWhen: stepCountIs(6),
      tools: {
        bash: bashToolkit.tools.bash,
      },
      providerOptions: buildProviderOptions({ withWebBrowsing }) as never,
    });
    return renderStream(result, output);
  };

  try {
    wroteOutput = await runStream(webBrowsingRequested);
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
    wroteOutput = await runStream(false);
  }

  if (wroteOutput) {
    output.write('\n');
  }

  return {
    provider: resolved.provider,
    modelId: resolved.modelId,
    webBrowsingRequested,
    webBrowsingUsed,
  };
}

function buildProviderOptions(options: {
  withWebBrowsing: boolean;
}): Record<string, unknown> {
  const googleOptions: Record<string, unknown> = {
    ...(THINKING_PROVIDER_OPTIONS.google as unknown as Record<string, unknown>),
  };
  if (options.withWebBrowsing) {
    googleOptions.useSearchGrounding = true;
  }
  return { google: googleOptions };
}

async function renderStream(
  result: {
    fullStream: AsyncIterable<{
      type: string;
      text?: string;
      error?: unknown;
    }>;
  },
  output: WritableLike,
): Promise<boolean> {
  const thinkingRenderer = createThinkingRenderer(output);
  let wroteOutput = false;
  try {
    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'reasoning-start': {
          thinkingRenderer.start();
          break;
        }
        case 'reasoning-delta': {
          thinkingRenderer.update(part.text ?? '');
          break;
        }
        case 'reasoning-end': {
          thinkingRenderer.stop();
          break;
        }
        case 'text-delta': {
          thinkingRenderer.pauseForText();
          output.write(part.text ?? '');
          wroteOutput = true;
          break;
        }
        case 'error': {
          throw part.error instanceof Error
            ? part.error
            : new DubError('AI assistant stream failed unexpectedly.');
        }
        default: {
          break;
        }
      }
    }
  } finally {
    thinkingRenderer.stop();
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

function resolveModel(deps: AskAiDependencies): {
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

function createThinkingRenderer(output: WritableLike): {
  start: () => void;
  update: (delta: string) => void;
  pauseForText: () => void;
  stop: () => void;
} {
  if (!output.isTTY) {
    return {
      start() {},
      update() {},
      pauseForText() {},
      stop() {},
    };
  }

  let spinnerIndex = 0;
  let preview = '';
  let lineLength = 0;
  let active = false;
  let hasRendered = false;

  const clearLine = () => {
    if (!hasRendered) return;
    output.write(`\r${' '.repeat(lineLength)}\r`);
    lineLength = 0;
    hasRendered = false;
  };

  const render = () => {
    const frame = SPINNER_FRAMES[spinnerIndex];
    spinnerIndex = (spinnerIndex + 1) % SPINNER_FRAMES.length;

    const summary =
      preview.length > 96 ? `${preview.slice(0, 93)}...` : preview;
    const line = `${frame} thinking: ${summary || 'working...'}`;
    output.write(`\r${line}`);
    lineLength = line.length;
    hasRendered = true;
  };

  return {
    start() {
      if (active) return;
      active = true;
      render();
    },
    update(delta: string) {
      if (!active) return;
      preview += delta;
      render();
    },
    pauseForText() {
      clearLine();
    },
    stop() {
      active = false;
      preview = '';
      clearLine();
    },
  };
}
