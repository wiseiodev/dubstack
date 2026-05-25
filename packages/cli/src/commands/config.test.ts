import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestRepo } from '../../test/helpers';
import { readConfig } from '../lib/config';
import {
  configAiAssistant,
  configAiDefaults,
  configAiModel,
  configAiPrompts,
  configAiPromptsAutoAccept,
  configAiProvider,
  configMcpMode,
} from './config';

let dir: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  const repo = await createTestRepo();
  dir = repo.dir;
  cleanup = repo.cleanup;
});

afterEach(async () => {
  await cleanup();
});

describe('config ai-assistant', () => {
  it('returns current value when state argument is omitted', async () => {
    const result = await configAiAssistant(dir);
    expect(result).toEqual({ enabled: false, changed: false });
  });

  it('writes enabled state when set to on', async () => {
    const result = await configAiAssistant(dir, 'on');
    const config = await readConfig(dir);

    expect(result).toEqual({ enabled: true, changed: true });
    expect(config.aiAssistantEnabled).toBe(true);
  });

  it('writes disabled state when set to off', async () => {
    await configAiAssistant(dir, 'on');
    const result = await configAiAssistant(dir, 'off');
    const config = await readConfig(dir);

    expect(result).toEqual({ enabled: false, changed: true });
    expect(config.aiAssistantEnabled).toBe(false);
  });

  it('throws for invalid state values', async () => {
    await expect(configAiAssistant(dir, 'maybe')).rejects.toThrow(
      "Value must be either 'on' or 'off'.",
    );
  });
});

describe('config ai-defaults', () => {
  it('returns current create default when state argument is omitted', async () => {
    const result = await configAiDefaults(dir, 'create');

    expect(result).toEqual({ enabled: false, changed: false });
  });

  it('writes submit default when set to on', async () => {
    const result = await configAiDefaults(dir, 'submit', 'on');
    const config = await readConfig(dir);

    expect(result).toEqual({ enabled: true, changed: true });
    expect(config.ai.defaults.submitDescription).toBe(true);
  });

  it('writes flow default when set to off', async () => {
    await configAiDefaults(dir, 'flow', 'on');
    const result = await configAiDefaults(dir, 'flow', 'off');
    const config = await readConfig(dir);

    expect(result).toEqual({ enabled: false, changed: true });
    expect(config.ai.defaults.flow).toBe(false);
  });

  it('throws for invalid default targets', async () => {
    await expect(configAiDefaults(dir, 'unknown' as never)).rejects.toThrow(
      "Config target must be one of 'create', 'submit', or 'flow'.",
    );
  });

  it('throws for invalid default state values', async () => {
    await expect(configAiDefaults(dir, 'create', 'maybe')).rejects.toThrow(
      "Value must be either 'on' or 'off'.",
    );
  });
});

describe('config ai-prompts', () => {
  it('returns current prompt mode when mode is omitted', async () => {
    const result = await configAiPrompts(dir);

    expect(result).toEqual({ mode: 'auto', changed: false });
  });

  it('writes prompt mode when set', async () => {
    const result = await configAiPrompts(dir, 'on');
    const config = await readConfig(dir);

    expect(result).toEqual({ mode: 'on', changed: true });
    expect(config.ai.prompts.mode).toBe('on');
  });

  it('throws for invalid prompt mode values', async () => {
    await expect(configAiPrompts(dir, 'maybe')).rejects.toThrow(
      "AI prompts must be one of 'auto', 'on', or 'off'.",
    );
  });
});

describe('config ai-prompts-auto-accept', () => {
  it('returns current auto-accept level when level is omitted', async () => {
    const result = await configAiPromptsAutoAccept(dir);

    expect(result).toEqual({ autoAccept: 'off', changed: false });
  });

  it('writes high auto-accept level when set', async () => {
    const result = await configAiPromptsAutoAccept(dir, 'high');
    const config = await readConfig(dir);

    expect(result).toEqual({ autoAccept: 'high', changed: true });
    expect(config.ai.prompts.autoAccept).toBe('high');
  });

  it('throws for invalid auto-accept values', async () => {
    await expect(configAiPromptsAutoAccept(dir, 'medium')).rejects.toThrow(
      "AI prompt auto-accept must be either 'off' or 'high'.",
    );
  });
});

describe('config ai-provider', () => {
  it('returns current provider when selection is omitted', async () => {
    const result = await configAiProvider(dir);

    expect(result).toEqual({ provider: 'auto', changed: false });
  });

  it('writes selected provider when set', async () => {
    const result = await configAiProvider(dir, 'anthropic');
    const config = await readConfig(dir);

    expect(result).toEqual({ provider: 'anthropic', changed: true });
    expect(config.ai.provider.selected).toBe('anthropic');
  });

  it('writes OpenAI as a selected provider', async () => {
    const result = await configAiProvider(dir, 'openai');
    const config = await readConfig(dir);

    expect(result).toEqual({ provider: 'openai', changed: true });
    expect(config.ai.provider.selected).toBe('openai');
  });

  it('writes Ollama as a selected provider', async () => {
    const result = await configAiProvider(dir, 'ollama');
    const config = await readConfig(dir);

    expect(result).toEqual({ provider: 'ollama', changed: true });
    expect(config.ai.provider.selected).toBe('ollama');
  });

  it('throws for invalid provider names', async () => {
    await expect(configAiProvider(dir, 'claude')).rejects.toThrow(
      "AI provider must be one of 'auto', 'gemini', 'anthropic', 'gateway', 'bedrock', 'openai', or 'ollama'.",
    );
  });
});

describe('config ai-model', () => {
  it('returns current model override when model is omitted', async () => {
    const result = await configAiModel(dir, 'bedrock');

    expect(result).toEqual({ model: null, changed: false });
  });

  it('writes a provider-specific model override', async () => {
    const result = await configAiModel(
      dir,
      'anthropic',
      'claude-sonnet-4-20250514',
    );
    const config = await readConfig(dir);

    expect(result).toEqual({
      model: 'claude-sonnet-4-20250514',
      changed: true,
    });
    expect(config.ai.provider.models.anthropic).toBe(
      'claude-sonnet-4-20250514',
    );
  });

  it('writes an OpenAI model override', async () => {
    const result = await configAiModel(dir, 'openai', 'gpt-5.5');
    const config = await readConfig(dir);

    expect(result).toEqual({
      model: 'gpt-5.5',
      changed: true,
    });
    expect(config.ai.provider.models.openai).toBe('gpt-5.5');
  });

  it('writes an Ollama model override', async () => {
    const result = await configAiModel(dir, 'ollama', 'qwen2.5-coder');
    const config = await readConfig(dir);

    expect(result).toEqual({
      model: 'qwen2.5-coder',
      changed: true,
    });
    expect(config.ai.provider.models.ollama).toBe('qwen2.5-coder');
  });

  it('clears a provider-specific model override', async () => {
    await configAiModel(dir, 'gateway', 'google/gemini-3-flash');

    const result = await configAiModel(dir, 'gateway', undefined, {
      clear: true,
    });
    const config = await readConfig(dir);

    expect(result).toEqual({ model: null, changed: true });
    expect(config.ai.provider.models.gateway).toBeNull();
  });

  it('throws when setting an empty model override', async () => {
    await expect(configAiModel(dir, 'gemini', '   ')).rejects.toThrow(
      'Model override cannot be empty.',
    );
  });
});

describe('config mcp-mode', () => {
  it('returns the default interactive mode when no mode is set', async () => {
    const result = await configMcpMode(dir);
    expect(result).toEqual({ mode: 'interactive', changed: false });
  });

  it('writes read-only mode when set', async () => {
    const result = await configMcpMode(dir, 'read-only');
    const config = await readConfig(dir);

    expect(result).toEqual({ mode: 'read-only', changed: true });
    expect(config.mcpMode).toBe('read-only');
  });

  it('writes trusted mode when set', async () => {
    const result = await configMcpMode(dir, 'trusted');
    const config = await readConfig(dir);

    expect(result).toEqual({ mode: 'trusted', changed: true });
    expect(config.mcpMode).toBe('trusted');
  });

  it('reports unchanged when re-setting the same mode', async () => {
    await configMcpMode(dir, 'trusted');
    const result = await configMcpMode(dir, 'trusted');
    expect(result).toEqual({ mode: 'trusted', changed: false });
  });

  it('throws for invalid modes', async () => {
    await expect(configMcpMode(dir, 'wide-open')).rejects.toThrow(
      "MCP mode must be one of 'read-only', 'interactive', or 'trusted'.",
    );
  });
});
