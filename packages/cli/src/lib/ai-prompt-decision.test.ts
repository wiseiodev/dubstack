import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type AiPromptDecisionDeps,
  aiPromptOptionsEnabled,
  parseRecommendation,
  resolveAiPromptDecision,
} from './ai-prompt-decision';
import type { DubConfig } from './config';

const baseConfig: DubConfig = {
  aiAssistantEnabled: true,
  mcpMode: 'interactive',
  reviewers: [],
  storageBackend: 'json',
  submitDefault: 'auto',
  theme: 'auto',
  ai: {
    defaults: {
      createMetadata: false,
      submitDescription: false,
      flow: false,
    },
    prompts: {
      mode: 'auto',
      autoAccept: 'off',
    },
    provider: {
      selected: 'gemini',
      models: {
        gemini: 'gemini-test',
        anthropic: null,
        gateway: null,
        bedrock: null,
        openai: null,
        ollama: null,
      },
    },
    shortcutFallback: {
      enabled: true,
      typoGuard: 'interactive',
      nonTtyPolicy: 'error-with-suggestion',
    },
    context: {
      shellHistory: {
        enabled: true,
        maxCommands: 200,
      },
    },
    webBrowsing: {
      mode: 'model-native',
      fallback: 'graceful',
    },
  },
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('aiPromptOptionsEnabled', () => {
  it('requires the global AI assistant flag', () => {
    expect(
      aiPromptOptionsEnabled({
        ...baseConfig,
        aiAssistantEnabled: false,
      }),
    ).toBe(false);
  });

  it('hides prompts when prompt mode is off', () => {
    expect(
      aiPromptOptionsEnabled({
        ...baseConfig,
        ai: {
          ...baseConfig.ai,
          prompts: {
            mode: 'off',
            autoAccept: 'off',
          },
        },
      }),
    ).toBe(false);
  });
});

describe('parseRecommendation', () => {
  it('parses fenced JSON recommendations', () => {
    expect(
      parseRecommendation<'remote'>(
        '```json\n{"choice":"remote","confidence":"high","reasoning":"clean"}\n```',
      ),
    ).toEqual({
      choice: 'remote',
      confidence: 'high',
      reasoning: 'clean',
    });
  });

  it('normalizes unknown confidence to low', () => {
    expect(
      parseRecommendation<'remote'>(
        '{"choice":"remote","confidence":"certain","reasoning":"maybe"}',
      ).confidence,
    ).toBe('low');
  });
});

describe('resolveAiPromptDecision', () => {
  it('auto-accepts high-confidence recommendations when configured', async () => {
    const deps = makeDeps({
      config: {
        ...baseConfig,
        ai: {
          ...baseConfig.ai,
          prompts: {
            mode: 'auto',
            autoAccept: 'high',
          },
        },
      },
      text: '{"choice":"remote","confidence":"high","reasoning":"safe"}',
    });

    const result = await resolveAiPromptDecision<'remote' | 'local'>({
      cwd: '/repo',
      scenario: 'test',
      subject: 'feat/a',
      context: 'context',
      choices: [
        { label: 'Remote', value: 'remote' },
        { label: 'Local', value: 'local' },
      ],
      fallbackPrompt: vi.fn().mockResolvedValue('local'),
      deps,
    });

    expect(result).toBe('remote');
    expect(deps.confirmRecommendation).not.toHaveBeenCalled();
  });

  it('falls back to manual choices for low-confidence recommendations', async () => {
    const fallbackPrompt = vi.fn().mockResolvedValue('local');
    const deps = makeDeps({
      config: baseConfig,
      text: '{"choice":"remote","confidence":"low","reasoning":"missing context"}',
    });

    const result = await resolveAiPromptDecision<'remote' | 'local'>({
      cwd: '/repo',
      scenario: 'test',
      subject: 'feat/a',
      context: 'context',
      choices: [
        { label: 'Remote', value: 'remote' },
        { label: 'Local', value: 'local' },
      ],
      fallbackPrompt,
      deps,
    });

    expect(result).toBe('local');
    expect(fallbackPrompt).toHaveBeenCalled();
  });

  it('falls back to manual choices for unsupported recommendations', async () => {
    const fallbackPrompt = vi.fn().mockResolvedValue('local');
    const deps = makeDeps({
      config: baseConfig,
      text: '{"choice":"delete-everything","confidence":"high","reasoning":"bad"}',
    });

    const result = await resolveAiPromptDecision<'remote' | 'local'>({
      cwd: '/repo',
      scenario: 'test',
      subject: 'feat/a',
      context: 'context',
      choices: [
        { label: 'Remote', value: 'remote' },
        { label: 'Local', value: 'local' },
      ],
      fallbackPrompt,
      deps,
    });

    expect(result).toBe('local');
    expect(fallbackPrompt).toHaveBeenCalled();
  });
});

function makeDeps(input: {
  config: DubConfig;
  text: string;
}): AiPromptDecisionDeps {
  vi.stubEnv('DUBSTACK_GEMINI_API_KEY', 'test-key');
  return {
    readConfig: vi.fn().mockResolvedValue(input.config),
    streamText: vi.fn(() => ({
      fullStream: streamTextChunks(input.text),
    })) as never,
    createGoogleGenerativeAI: vi.fn(() => vi.fn(() => ({}) as never)) as never,
    createGateway: vi.fn() as never,
    createAmazonBedrock: vi.fn() as never,
    fromIni: vi.fn() as never,
    fromNodeProviderChain: vi.fn() as never,
    confirmRecommendation: vi.fn().mockResolvedValue(true),
    writePreview: vi.fn(),
  };
}

async function* streamTextChunks(text: string) {
  yield {
    type: 'text-delta' as const,
    text,
  };
}
