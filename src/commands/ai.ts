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
    },
  },
};

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

  const result = deps.streamText({
    model: resolved.model,
    system: buildAiSystemPrompt(),
    prompt: contextPrompt,
    stopWhen: stepCountIs(6),
    tools: {
      bash: bashToolkit.tools.bash,
    },
    providerOptions: THINKING_PROVIDER_OPTIONS,
  });

  let wroteOutput = false;
  for await (const part of result.textStream) {
    output.write(part);
    wroteOutput = true;
  }

  if (wroteOutput) {
    output.write('\n');
  }

  return {
    provider: resolved.provider,
    modelId: resolved.modelId,
  };
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
