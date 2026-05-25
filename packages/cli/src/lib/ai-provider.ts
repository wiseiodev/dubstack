import { execFileSync } from 'node:child_process';
import type { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import type { createAnthropic } from '@ai-sdk/anthropic';
import type { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { createOpenAI } from '@ai-sdk/openai';
import type { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type {
  fromIni,
  fromNodeProviderChain,
} from '@aws-sdk/credential-providers';
import type { createGateway, LanguageModel } from 'ai';
import type { DubConfig } from './config';
import { DubError } from './errors';

export type ResolvedAiProviderName =
  | 'google'
  | 'anthropic'
  | 'gateway'
  | 'bedrock'
  | 'openai'
  | 'ollama';

const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';
const DEFAULT_OLLAMA_MODEL = 'qwen2.5-coder';

export interface ResolveAiProviderDeps {
  createGoogleGenerativeAI: typeof createGoogleGenerativeAI;
  createAnthropic?: typeof createAnthropic;
  createGateway: typeof createGateway;
  createAmazonBedrock?: typeof createAmazonBedrock;
  createOpenAI?: typeof createOpenAI;
  createOpenAICompatible?: typeof createOpenAICompatible;
  checkOllamaEndpoint?: (baseUrl: string) => void;
  fromIni?: typeof fromIni;
  fromNodeProviderChain?: typeof fromNodeProviderChain;
}

export interface ResolvedAiProvider {
  provider: ResolvedAiProviderName;
  model: LanguageModel;
  modelId: string;
}

export function resolveAiProvider(input: {
  deps: ResolveAiProviderDeps;
  providerConfig: DubConfig['ai']['provider'];
}): ResolvedAiProvider {
  const providerConfig = input.providerConfig;
  const selected = providerConfig.selected;

  if (selected === 'gemini') {
    return resolveGoogleProvider(input.deps, providerConfig);
  }

  if (selected === 'anthropic') {
    return resolveAnthropicProvider(input.deps, providerConfig);
  }

  if (selected === 'gateway') {
    return resolveGatewayProvider(input.deps, providerConfig);
  }

  if (selected === 'bedrock') {
    return resolveBedrockProvider(input.deps, providerConfig);
  }

  if (selected === 'openai') {
    return resolveOpenAiProvider(input.deps, providerConfig);
  }

  if (selected === 'ollama') {
    return resolveOllamaProvider(input.deps, providerConfig);
  }

  const geminiApiKey = process.env.DUBSTACK_GEMINI_API_KEY?.trim();
  if (geminiApiKey) {
    return resolveGoogleProvider(input.deps, providerConfig);
  }

  const anthropicApiKey = process.env.DUBSTACK_ANTHROPIC_API_KEY?.trim();
  if (anthropicApiKey) {
    return resolveAnthropicProvider(input.deps, providerConfig);
  }

  const gatewayApiKey = process.env.DUBSTACK_AI_GATEWAY_API_KEY?.trim();
  if (gatewayApiKey) {
    return resolveGatewayProvider(input.deps, providerConfig);
  }

  const bedrockRegion = process.env.DUBSTACK_BEDROCK_AWS_REGION?.trim();
  const bedrockModel = getConfiguredModel('bedrock', providerConfig);
  if (bedrockRegion && bedrockModel) {
    return resolveBedrockProvider(input.deps, providerConfig);
  }

  const openAiApiKey = process.env.DUBSTACK_OPENAI_API_KEY?.trim();
  if (openAiApiKey) {
    return resolveOpenAiProvider(input.deps, providerConfig);
  }

  if (isOllamaEnvConfigured()) {
    return resolveOllamaProvider(input.deps, providerConfig);
  }

  throw new DubError('AI assistant has no configured provider.', [
    "Run 'dub ai setup' for an interactive guided setup.",
    "Run 'dub ai env --gemini-key <key>' to configure Gemini.",
    "Run 'dub ai env --anthropic-key <key>' to configure Anthropic.",
    "Run 'dub ai env --gateway-key <key>' to configure the AI Gateway.",
    "Run 'dub ai env --bedrock-region <region> --bedrock-model <model>' to configure Bedrock.",
    "Run 'dub ai env --openai-key <key>' to configure OpenAI.",
    "Run 'dub config ai-provider ollama' to use a local Ollama endpoint.",
  ]);
}

export function buildAiProviderOptions(
  provider: Pick<ResolvedAiProvider, 'provider' | 'modelId'>,
  options: { withWebBrowsing: boolean },
): Record<string, unknown> {
  if (provider.provider === 'google') {
    const googleOptions: Record<string, unknown> = {
      thinkingConfig: {
        thinkingLevel: 'high',
        includeThoughts: true,
      },
    };
    if (options.withWebBrowsing) {
      googleOptions.useSearchGrounding = true;
    }
    return { google: googleOptions };
  }

  if (
    provider.provider === 'bedrock' &&
    supportsBedrockReasoning(provider.modelId)
  ) {
    return {
      bedrock: {
        reasoningConfig: {
          type: 'enabled',
          budgetTokens: 4096,
        },
      },
    };
  }

  return {};
}

function resolveGoogleProvider(
  deps: ResolveAiProviderDeps,
  providerConfig: DubConfig['ai']['provider'],
): ResolvedAiProvider {
  const geminiApiKey = process.env.DUBSTACK_GEMINI_API_KEY?.trim();
  if (!geminiApiKey) {
    throw new DubError(
      'Gemini is selected but DUBSTACK_GEMINI_API_KEY is not set.',
      [
        "Run 'dub ai setup' for guided provider setup.",
        "Run 'dub ai env --gemini-key <key>' to write the key to your shell profile.",
      ],
    );
  }

  const geminiModel =
    getConfiguredModel('gemini', providerConfig) || 'gemini-3-flash-preview';
  const google = deps.createGoogleGenerativeAI({ apiKey: geminiApiKey });

  return {
    provider: 'google',
    model: google(geminiModel),
    modelId: geminiModel,
  };
}

function resolveAnthropicProvider(
  deps: ResolveAiProviderDeps,
  providerConfig: DubConfig['ai']['provider'],
): ResolvedAiProvider {
  if (!deps.createAnthropic) {
    throw new DubError('Anthropic support is unavailable in this build.', [
      "Run 'dub config ai-provider gemini', 'gateway', or 'bedrock' to switch providers.",
      'Reinstall DubStack from a build that includes Anthropic support if you need it.',
    ]);
  }

  const anthropicApiKey = process.env.DUBSTACK_ANTHROPIC_API_KEY?.trim();
  if (!anthropicApiKey) {
    throw new DubError(
      'Anthropic is selected but DUBSTACK_ANTHROPIC_API_KEY is not set.',
      [
        "Run 'dub ai setup' for guided provider setup.",
        "Run 'dub ai env --anthropic-key <key>' to write the key to your shell profile.",
      ],
    );
  }

  const modelId =
    getConfiguredModel('anthropic', providerConfig) ||
    'claude-sonnet-4-20250514';
  const anthropic = deps.createAnthropic({ apiKey: anthropicApiKey });

  return {
    provider: 'anthropic',
    model: anthropic(modelId),
    modelId,
  };
}

function resolveGatewayProvider(
  deps: ResolveAiProviderDeps,
  providerConfig: DubConfig['ai']['provider'],
): ResolvedAiProvider {
  const gatewayApiKey = process.env.DUBSTACK_AI_GATEWAY_API_KEY?.trim();
  if (!gatewayApiKey) {
    throw new DubError(
      'AI Gateway is selected but DUBSTACK_AI_GATEWAY_API_KEY is not set.',
      [
        "Run 'dub ai setup' for guided provider setup.",
        "Run 'dub ai env --gateway-key <key>' to write the key to your shell profile.",
      ],
    );
  }

  const gatewayModel =
    getConfiguredModel('gateway', providerConfig) || 'google/gemini-3-flash';
  const gateway = deps.createGateway({ apiKey: gatewayApiKey });

  return {
    provider: 'gateway',
    model: gateway(gatewayModel),
    modelId: gatewayModel,
  };
}

function resolveBedrockProvider(
  deps: ResolveAiProviderDeps,
  providerConfig: DubConfig['ai']['provider'],
): ResolvedAiProvider {
  if (
    !deps.createAmazonBedrock ||
    !deps.fromIni ||
    !deps.fromNodeProviderChain
  ) {
    throw new DubError('Bedrock support is unavailable in this build.', [
      "Run 'dub config ai-provider gemini' or 'gateway' to switch providers.",
      'Reinstall DubStack from a build that includes Bedrock support if you need it.',
    ]);
  }

  const region = process.env.DUBSTACK_BEDROCK_AWS_REGION?.trim();
  if (!region) {
    throw new DubError(
      'Bedrock is selected but DUBSTACK_BEDROCK_AWS_REGION is not set.',
      [
        "Run 'dub ai setup' for guided provider setup.",
        "Run 'dub ai env --bedrock-region <region>' to write the region to your shell profile.",
      ],
    );
  }

  const modelId = getConfiguredModel('bedrock', providerConfig);
  if (!modelId) {
    throw new DubError(
      'Bedrock is selected but DUBSTACK_BEDROCK_MODEL is not set and no repo override exists.',
      [
        "Run 'dub ai setup' for guided provider setup.",
        "Run 'dub ai env --bedrock-model <model>' to write the model to your shell profile.",
        "Run 'dub config ai-model <model> --provider bedrock' to set a repo-local override.",
      ],
    );
  }

  const profile = process.env.DUBSTACK_BEDROCK_AWS_PROFILE?.trim();
  const credentialProvider = profile
    ? deps.fromIni({ profile })
    : deps.fromNodeProviderChain();
  const bedrock = deps.createAmazonBedrock({
    region,
    credentialProvider,
  });

  return {
    provider: 'bedrock',
    model: bedrock(modelId),
    modelId,
  };
}

function resolveOpenAiProvider(
  deps: ResolveAiProviderDeps,
  providerConfig: DubConfig['ai']['provider'],
): ResolvedAiProvider {
  if (!deps.createOpenAI) {
    throw new DubError('OpenAI support is unavailable in this build.', [
      "Run 'dub config ai-provider gemini', 'gateway', or 'bedrock' to switch providers.",
      'Reinstall DubStack from a build that includes OpenAI support if you need it.',
    ]);
  }

  const openAiApiKey = process.env.DUBSTACK_OPENAI_API_KEY?.trim();
  if (!openAiApiKey) {
    throw new DubError(
      'OpenAI is selected but DUBSTACK_OPENAI_API_KEY is not set.',
      [
        "Run 'dub ai setup' for guided provider setup.",
        "Run 'dub ai env --openai-key <key>' to write the key to your shell profile.",
      ],
    );
  }

  const modelId = getConfiguredModel('openai', providerConfig) || 'gpt-5.5';
  const openai = deps.createOpenAI({ apiKey: openAiApiKey });

  return {
    provider: 'openai',
    model: openai(modelId),
    modelId,
  };
}

function resolveOllamaProvider(
  deps: ResolveAiProviderDeps,
  providerConfig: DubConfig['ai']['provider'],
): ResolvedAiProvider {
  if (!deps.createOpenAICompatible) {
    throw new DubError('Ollama support is unavailable in this build.', [
      "Run 'dub config ai-provider gemini', 'gateway', or 'openai' to switch providers.",
      'Reinstall DubStack from a build that includes Ollama support if you need it.',
    ]);
  }

  const baseUrl = getOllamaBaseUrl();
  const checkEndpoint = deps.checkOllamaEndpoint ?? checkOllamaEndpoint;
  checkEndpoint(baseUrl);

  const modelId =
    getConfiguredModel('ollama', providerConfig) || DEFAULT_OLLAMA_MODEL;
  const ollama = deps.createOpenAICompatible({
    name: 'ollama',
    baseURL: toOpenAiCompatibleBaseUrl(baseUrl),
  });

  return {
    provider: 'ollama',
    model: ollama(modelId),
    modelId,
  };
}

function getConfiguredModel(
  provider: keyof DubConfig['ai']['provider']['models'],
  providerConfig: DubConfig['ai']['provider'],
): string | null {
  const repoModel = providerConfig.models[provider];
  if (repoModel?.trim()) {
    return repoModel.trim();
  }

  if (provider === 'gemini') {
    return normalizeEnvModel(process.env.DUBSTACK_GEMINI_MODEL);
  }

  if (provider === 'gateway') {
    return normalizeEnvModel(process.env.DUBSTACK_AI_GATEWAY_MODEL);
  }

  if (provider === 'anthropic') {
    return normalizeEnvModel(process.env.DUBSTACK_ANTHROPIC_MODEL);
  }

  if (provider === 'bedrock') {
    return normalizeEnvModel(process.env.DUBSTACK_BEDROCK_MODEL);
  }

  if (provider === 'ollama') {
    return normalizeEnvModel(process.env.DUBSTACK_OLLAMA_MODEL);
  }

  return normalizeEnvModel(process.env.DUBSTACK_OPENAI_MODEL);
}

function normalizeEnvModel(value: string | undefined): string | null {
  const model = value?.trim();
  return model ? model : null;
}

function supportsBedrockReasoning(modelId: string): boolean {
  return /claude-3-7|claude-(sonnet|opus|haiku)-4/.test(modelId);
}

function isOllamaEnvConfigured(): boolean {
  return Boolean(
    process.env.DUBSTACK_OLLAMA_BASE_URL?.trim() ||
      process.env.DUBSTACK_OLLAMA_MODEL?.trim(),
  );
}

export function getOllamaBaseUrl(): string {
  return normalizeOllamaBaseUrl(
    process.env.DUBSTACK_OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL,
  );
}

export function normalizeOllamaBaseUrl(value: string): string {
  const baseUrl = value.trim().replace(/\/+$/, '');
  if (!baseUrl) {
    throw new DubError('Ollama base URL cannot be empty.', [
      `Pass a non-empty URL (e.g. '${DEFAULT_OLLAMA_BASE_URL}').`,
    ]);
  }

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new DubError('Ollama base URL must be a valid URL.', [
      `Pass a URL like '${DEFAULT_OLLAMA_BASE_URL}'.`,
    ]);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new DubError('Ollama base URL must use http or https.', [
      `Pass a URL like '${DEFAULT_OLLAMA_BASE_URL}'.`,
    ]);
  }

  return baseUrl;
}

export function toOpenAiCompatibleBaseUrl(baseUrl: string): string {
  const normalized = normalizeOllamaBaseUrl(baseUrl);
  return normalized.endsWith('/v1') ? normalized : `${normalized}/v1`;
}

export function getOllamaTagsUrl(baseUrl: string): string {
  const normalized = normalizeOllamaBaseUrl(baseUrl);
  const root = normalized.endsWith('/v1')
    ? normalized.slice(0, -'/v1'.length)
    : normalized;
  return `${root}/api/tags`;
}

export function checkOllamaEndpoint(
  baseUrl: string,
  execFile: typeof execFileSync = execFileSync,
): void {
  const healthCheckUrl = getOllamaHealthCheckUrl(baseUrl);
  try {
    execFile(
      'curl',
      ['--fail', '--silent', '--show-error', '--max-time', '2', healthCheckUrl],
      {
        stdio: 'pipe',
      },
    );
  } catch {
    throw new DubError(
      'Ollama provider is selected but the local endpoint is not reachable.',
      [
        `Start Ollama and verify '${healthCheckUrl}' responds.`,
        "For LM Studio, set DUBSTACK_OLLAMA_BASE_URL to the server's '/v1' endpoint.",
        `Set DUBSTACK_OLLAMA_BASE_URL if your endpoint is not '${DEFAULT_OLLAMA_BASE_URL}'.`,
        "Run 'dub config ai-provider <provider>' to switch providers.",
      ],
    );
  }
}

function getOllamaHealthCheckUrl(baseUrl: string): string {
  const normalized = normalizeOllamaBaseUrl(baseUrl);
  return normalized.endsWith('/v1')
    ? `${normalized}/models`
    : getOllamaTagsUrl(normalized);
}
