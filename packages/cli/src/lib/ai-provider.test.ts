import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildAiProviderOptions,
  type ResolveAiProviderDeps,
  resolveAiProvider,
} from './ai-provider';
import type { DubConfig } from './config';

let envSnapshot: NodeJS.ProcessEnv;

beforeEach(() => {
  envSnapshot = { ...process.env };
});

afterEach(() => {
  process.env = envSnapshot;
});

function createDeps(): ResolveAiProviderDeps {
  return {
    createGoogleGenerativeAI: vi.fn().mockReturnValue(vi.fn()),
    createGateway: vi.fn().mockReturnValue(vi.fn()),
    createAmazonBedrock: vi.fn().mockReturnValue(vi.fn()),
    fromIni: vi.fn().mockReturnValue('ini-credentials'),
    fromNodeProviderChain: vi.fn().mockReturnValue('default-chain'),
  };
}

function createConfig(
  overrides: {
    selected?: DubConfig['ai']['provider']['selected'];
    models?: Partial<DubConfig['ai']['provider']['models']>;
  } = {},
): DubConfig['ai']['provider'] {
  const models = {
    gemini: null,
    gateway: null,
    bedrock: null,
    ...overrides.models,
  };

  return {
    selected: 'auto',
    ...overrides,
    models,
  };
}

describe('resolveAiProvider', () => {
  it('uses the explicitly selected Bedrock provider and repo model override', () => {
    process.env.DUBSTACK_GEMINI_API_KEY = 'gem-key';
    process.env.DUBSTACK_BEDROCK_AWS_PROFILE = 'bw-sso';
    process.env.DUBSTACK_BEDROCK_AWS_REGION = 'us-west-2';
    process.env.DUBSTACK_BEDROCK_MODEL = 'env-bedrock-model';

    const bedrockModel = vi.fn().mockReturnValue('bedrock-model');
    const deps = createDeps();
    deps.createAmazonBedrock = vi.fn().mockReturnValue(bedrockModel);

    const resolved = resolveAiProvider({
      deps,
      providerConfig: createConfig({
        selected: 'bedrock',
        models: {
          bedrock: 'repo-bedrock-model',
        },
      }),
    });

    expect(deps.fromIni).toHaveBeenCalledWith({ profile: 'bw-sso' });
    expect(deps.fromNodeProviderChain).not.toHaveBeenCalled();
    expect(deps.createAmazonBedrock).toHaveBeenCalledWith({
      region: 'us-west-2',
      credentialProvider: 'ini-credentials',
    });
    expect(bedrockModel).toHaveBeenCalledWith('repo-bedrock-model');
    expect(resolved.provider).toBe('bedrock');
    expect(resolved.modelId).toBe('repo-bedrock-model');
  });

  it('uses the default AWS credential chain when no Bedrock profile is set', () => {
    process.env.DUBSTACK_BEDROCK_AWS_REGION = 'us-east-1';
    process.env.DUBSTACK_BEDROCK_MODEL = 'us.anthropic.claude-sonnet-4-6';

    const deps = createDeps();
    const bedrockModel = vi.fn().mockReturnValue('bedrock-model');
    deps.createAmazonBedrock = vi.fn().mockReturnValue(bedrockModel);

    resolveAiProvider({
      deps,
      providerConfig: createConfig({ selected: 'bedrock' }),
    });

    expect(deps.fromIni).not.toHaveBeenCalled();
    expect(deps.fromNodeProviderChain).toHaveBeenCalledTimes(1);
    expect(deps.createAmazonBedrock).toHaveBeenCalledWith({
      region: 'us-east-1',
      credentialProvider: 'default-chain',
    });
  });

  it('uses gateway when selected explicitly even if gemini is configured', () => {
    process.env.DUBSTACK_GEMINI_API_KEY = 'gem-key';
    process.env.DUBSTACK_AI_GATEWAY_API_KEY = 'gateway-key';
    process.env.DUBSTACK_AI_GATEWAY_MODEL = 'google/gemini-2.5-pro';

    const deps = createDeps();
    const gatewayModel = vi.fn().mockReturnValue('gateway-model');
    deps.createGateway = vi.fn().mockReturnValue(gatewayModel);

    const resolved = resolveAiProvider({
      deps,
      providerConfig: createConfig({ selected: 'gateway' }),
    });

    expect(deps.createGoogleGenerativeAI).not.toHaveBeenCalled();
    expect(deps.createGateway).toHaveBeenCalledWith({ apiKey: 'gateway-key' });
    expect(gatewayModel).toHaveBeenCalledWith('google/gemini-2.5-pro');
    expect(resolved.provider).toBe('gateway');
  });

  it('preserves the existing auto fallback order of gemini, gateway, then bedrock', () => {
    process.env.DUBSTACK_GEMINI_API_KEY = 'gem-key';
    process.env.DUBSTACK_AI_GATEWAY_API_KEY = 'gateway-key';
    process.env.DUBSTACK_BEDROCK_AWS_REGION = 'us-east-1';
    process.env.DUBSTACK_BEDROCK_MODEL = 'bedrock-model';

    const deps = createDeps();
    const googleModel = vi.fn().mockReturnValue('google-model');
    deps.createGoogleGenerativeAI = vi.fn().mockReturnValue(googleModel);

    const resolved = resolveAiProvider({
      deps,
      providerConfig: createConfig(),
    });

    expect(deps.createGoogleGenerativeAI).toHaveBeenCalledWith({
      apiKey: 'gem-key',
    });
    expect(resolved.provider).toBe('google');
  });

  it('throws when Bedrock is selected without a configured region', () => {
    process.env.DUBSTACK_BEDROCK_MODEL = 'bedrock-model';

    expect(() =>
      resolveAiProvider({
        deps: createDeps(),
        providerConfig: createConfig({ selected: 'bedrock' }),
      }),
    ).toThrow('DUBSTACK_BEDROCK_AWS_REGION');
  });
});

describe('buildAiProviderOptions', () => {
  it('returns google thinking and search grounding only for google models', () => {
    expect(
      buildAiProviderOptions(
        {
          provider: 'google',
          modelId: 'gemini-3-flash-preview',
        },
        {
          withWebBrowsing: true,
        },
      ),
    ).toEqual({
      google: {
        thinkingConfig: {
          thinkingLevel: 'high',
          includeThoughts: true,
        },
        useSearchGrounding: true,
      },
    });
  });

  it('returns Bedrock reasoning options for reasoning-capable Anthropic models', () => {
    expect(
      buildAiProviderOptions(
        {
          provider: 'bedrock',
          modelId: 'us.anthropic.claude-sonnet-4-6',
        },
        {
          withWebBrowsing: true,
        },
      ),
    ).toEqual({
      bedrock: {
        reasoningConfig: {
          type: 'enabled',
          budgetTokens: 4096,
        },
      },
    });
  });

  it('returns no provider options for gateway or non-reasoning Bedrock models', () => {
    expect(
      buildAiProviderOptions(
        {
          provider: 'gateway',
          modelId: 'google/gemini-3-flash',
        },
        {
          withWebBrowsing: true,
        },
      ),
    ).toEqual({});
    expect(
      buildAiProviderOptions(
        {
          provider: 'bedrock',
          modelId: 'amazon.nova-lite-v1:0',
        },
        {
          withWebBrowsing: true,
        },
      ),
    ).toEqual({});
  });
});
