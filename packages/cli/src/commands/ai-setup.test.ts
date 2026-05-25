import { beforeEach, describe, expect, it, vi } from 'vitest';
import { aiSetup } from './ai-setup';

function createDeps() {
  return {
    selectProvider: vi.fn(),
    selectModel: vi.fn(),
    inputCustomModel: vi.fn(),
    selectModelScope: vi.fn(),
    inputGeminiKey: vi.fn(),
    inputAnthropicKey: vi.fn(),
    inputGatewayKey: vi.fn(),
    inputOpenAiKey: vi.fn(),
    inputOllamaBaseUrl: vi.fn(),
    inputBedrockProfile: vi.fn(),
    inputBedrockRegion: vi.fn(),
    checkOllamaEndpoint: vi.fn(),
    configureAiEnv: vi.fn().mockResolvedValue({
      profilePath: '/tmp/.zshrc',
      updated: [],
      activationCommand: "source '/tmp/.zshrc'",
    }),
    configAiProvider: vi.fn().mockResolvedValue({
      provider: 'auto',
      changed: true,
    }),
    configAiModel: vi.fn().mockResolvedValue({
      model: null,
      changed: true,
    }),
  };
}

describe('aiSetup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes Bedrock env defaults and selects the provider for the repo', async () => {
    const deps = createDeps();
    deps.selectProvider.mockResolvedValue('bedrock');
    deps.selectModel.mockResolvedValue('us.anthropic.claude-sonnet-4-6');
    deps.selectModelScope.mockResolvedValue('global');
    deps.inputBedrockProfile.mockResolvedValue('bw-sso');
    deps.inputBedrockRegion.mockResolvedValue('us-west-2');

    const result = await aiSetup('/repo', deps);

    expect(deps.configureAiEnv).toHaveBeenCalledWith({
      bedrockProfile: 'bw-sso',
      bedrockRegion: 'us-west-2',
      bedrockModel: 'us.anthropic.claude-sonnet-4-6',
    });
    expect(deps.configAiProvider).toHaveBeenCalledWith('/repo', 'bedrock');
    expect(deps.configAiModel).toHaveBeenCalledWith(
      '/repo',
      'bedrock',
      undefined,
      {
        clear: true,
      },
    );
    expect(result.provider).toBe('bedrock');
    expect(result.model).toBe('us.anthropic.claude-sonnet-4-6');
    expect(result.modelScope).toBe('global');
    expect(result.profilePath).toBe('/tmp/.zshrc');
    expect(result.activationCommand).toBe("source '/tmp/.zshrc'");
  });

  it('stores a repo-only custom model override for Gemini', async () => {
    const deps = createDeps();
    deps.selectProvider.mockResolvedValue('gemini');
    deps.selectModel.mockResolvedValue('__custom__');
    deps.inputCustomModel.mockResolvedValue('gemini-2.5-pro-preview');
    deps.selectModelScope.mockResolvedValue('repo');
    deps.inputGeminiKey.mockResolvedValue('gem-key');

    const result = await aiSetup('/repo', deps);

    expect(deps.configureAiEnv).toHaveBeenCalledWith({
      geminiKey: 'gem-key',
    });
    expect(deps.configAiProvider).toHaveBeenCalledWith('/repo', 'gemini');
    expect(deps.configAiModel).toHaveBeenCalledWith(
      '/repo',
      'gemini',
      'gemini-2.5-pro-preview',
    );
    expect(result.modelScope).toBe('repo');
  });

  it('writes Anthropic env defaults and selects the provider for the repo', async () => {
    const deps = createDeps();
    deps.selectProvider.mockResolvedValue('anthropic');
    deps.selectModel.mockResolvedValue('claude-sonnet-4-20250514');
    deps.selectModelScope.mockResolvedValue('global');
    deps.inputAnthropicKey.mockResolvedValue('anthropic-key');

    const result = await aiSetup('/repo', deps);

    expect(deps.configureAiEnv).toHaveBeenCalledWith({
      anthropicKey: 'anthropic-key',
      anthropicModel: 'claude-sonnet-4-20250514',
    });
    expect(deps.configAiProvider).toHaveBeenCalledWith('/repo', 'anthropic');
    expect(deps.configAiModel).toHaveBeenCalledWith(
      '/repo',
      'anthropic',
      undefined,
      {
        clear: true,
      },
    );
    expect(result.provider).toBe('anthropic');
    expect(result.model).toBe('claude-sonnet-4-20250514');
    expect(result.modelScope).toBe('global');
  });

  it('supports repo-only setup without shell profile edits', async () => {
    const deps = createDeps();
    deps.selectProvider.mockResolvedValue('gateway');
    deps.selectModel.mockResolvedValue('google/gemini-3-flash');
    deps.selectModelScope.mockResolvedValue('repo');
    deps.inputGatewayKey.mockResolvedValue(undefined);

    const result = await aiSetup('/repo', deps);

    expect(deps.configureAiEnv).not.toHaveBeenCalled();
    expect(deps.configAiProvider).toHaveBeenCalledWith('/repo', 'gateway');
    expect(deps.configAiModel).toHaveBeenCalledWith(
      '/repo',
      'gateway',
      'google/gemini-3-flash',
    );
    expect(result.updatedEnv).toEqual([]);
    expect(result.profilePath).toBeUndefined();
    expect(result.activationCommand).toBeUndefined();
  });

  it('writes OpenAI env defaults and selects the provider for the repo', async () => {
    const deps = createDeps();
    deps.selectProvider.mockResolvedValue('openai');
    deps.selectModel.mockResolvedValue('gpt-5.5');
    deps.selectModelScope.mockResolvedValue('global');
    deps.inputOpenAiKey.mockResolvedValue('openai-key');

    const result = await aiSetup('/repo', deps);

    expect(deps.configureAiEnv).toHaveBeenCalledWith({
      openaiKey: 'openai-key',
      openaiModel: 'gpt-5.5',
    });
    expect(deps.configAiProvider).toHaveBeenCalledWith('/repo', 'openai');
    expect(deps.configAiModel).toHaveBeenCalledWith(
      '/repo',
      'openai',
      undefined,
      {
        clear: true,
      },
    );
    expect(result.provider).toBe('openai');
    expect(result.model).toBe('gpt-5.5');
  });

  it('checks Ollama reachability and writes local endpoint defaults', async () => {
    const deps = createDeps();
    deps.selectProvider.mockResolvedValue('ollama');
    deps.selectModel.mockResolvedValue('qwen2.5-coder');
    deps.selectModelScope.mockResolvedValue('global');
    deps.inputOllamaBaseUrl.mockResolvedValue('http://localhost:11434');

    const result = await aiSetup('/repo', deps);

    expect(deps.checkOllamaEndpoint).toHaveBeenCalledWith(
      'http://localhost:11434',
    );
    expect(deps.configureAiEnv).toHaveBeenCalledWith({
      ollamaBaseUrl: 'http://localhost:11434',
      ollamaModel: 'qwen2.5-coder',
    });
    expect(deps.configAiProvider).toHaveBeenCalledWith('/repo', 'ollama');
    expect(deps.configAiModel).toHaveBeenCalledWith(
      '/repo',
      'ollama',
      undefined,
      {
        clear: true,
      },
    );
    expect(result.provider).toBe('ollama');
    expect(result.model).toBe('qwen2.5-coder');
  });

  it('clears an existing repo override when switching back to global scope', async () => {
    const deps = createDeps();
    deps.selectProvider.mockResolvedValue('bedrock');
    deps.selectModel.mockResolvedValue('us.anthropic.claude-sonnet-4-6');
    deps.selectModelScope.mockResolvedValue('global');
    deps.inputBedrockProfile.mockResolvedValue(undefined);
    deps.inputBedrockRegion.mockResolvedValue('us-west-2');

    await aiSetup('/repo', deps);

    expect(deps.configureAiEnv).toHaveBeenCalledWith({
      bedrockProfile: undefined,
      bedrockRegion: 'us-west-2',
      bedrockModel: 'us.anthropic.claude-sonnet-4-6',
    });
    expect(deps.configAiModel).toHaveBeenCalledWith(
      '/repo',
      'bedrock',
      undefined,
      {
        clear: true,
      },
    );
  });
});
