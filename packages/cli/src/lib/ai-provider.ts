import type { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import type { createGoogleGenerativeAI } from '@ai-sdk/google';
import type {
  fromIni,
  fromNodeProviderChain,
} from '@aws-sdk/credential-providers';
import type { createGateway, LanguageModel } from 'ai';
import type { DubConfig } from './config';
import { DubError } from './errors';

export type ResolvedAiProviderName = 'google' | 'gateway' | 'bedrock';

export interface ResolveAiProviderDeps {
  createGoogleGenerativeAI: typeof createGoogleGenerativeAI;
  createGateway: typeof createGateway;
  createAmazonBedrock?: typeof createAmazonBedrock;
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

  if (selected === 'gateway') {
    return resolveGatewayProvider(input.deps, providerConfig);
  }

  if (selected === 'bedrock') {
    return resolveBedrockProvider(input.deps, providerConfig);
  }

  const geminiApiKey = process.env.DUBSTACK_GEMINI_API_KEY?.trim();
  if (geminiApiKey) {
    return resolveGoogleProvider(input.deps, providerConfig);
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

  throw new DubError(
    "AI assistant requires one of: DUBSTACK_GEMINI_API_KEY, DUBSTACK_AI_GATEWAY_API_KEY, or the Bedrock pair DUBSTACK_BEDROCK_AWS_REGION + DUBSTACK_BEDROCK_MODEL. Run 'dub ai setup' or 'dub ai env' to configure a provider.",
  );
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
      "Gemini is selected but DUBSTACK_GEMINI_API_KEY is not set. Run 'dub ai setup' or 'dub ai env --gemini-key <key>'.",
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

function resolveGatewayProvider(
  deps: ResolveAiProviderDeps,
  providerConfig: DubConfig['ai']['provider'],
): ResolvedAiProvider {
  const gatewayApiKey = process.env.DUBSTACK_AI_GATEWAY_API_KEY?.trim();
  if (!gatewayApiKey) {
    throw new DubError(
      "AI Gateway is selected but DUBSTACK_AI_GATEWAY_API_KEY is not set. Run 'dub ai setup' or 'dub ai env --gateway-key <key>'.",
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
    throw new DubError('Bedrock support is unavailable in this build.');
  }

  const region = process.env.DUBSTACK_BEDROCK_AWS_REGION?.trim();
  if (!region) {
    throw new DubError(
      "Bedrock is selected but DUBSTACK_BEDROCK_AWS_REGION is not set. Run 'dub ai setup' or 'dub ai env --bedrock-region <region>'.",
    );
  }

  const modelId = getConfiguredModel('bedrock', providerConfig);
  if (!modelId) {
    throw new DubError(
      "Bedrock is selected but DUBSTACK_BEDROCK_MODEL is not set and no repo override exists. Run 'dub ai setup' or 'dub ai env --bedrock-model <model>'.",
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

  return normalizeEnvModel(process.env.DUBSTACK_BEDROCK_MODEL);
}

function normalizeEnvModel(value: string | undefined): string | null {
  const model = value?.trim();
  return model ? model : null;
}

function supportsBedrockReasoning(modelId: string): boolean {
  return /claude-3-7|claude-(sonnet|opus|haiku)-4/.test(modelId);
}
