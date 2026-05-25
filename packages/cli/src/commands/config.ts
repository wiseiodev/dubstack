import type { DubConfig, McpMode } from '../lib/config';
import { readConfig, writeConfig } from '../lib/config';
import { DubError } from '../lib/errors';

export interface ConfigBooleanResult {
  enabled: boolean;
  changed: boolean;
}

export interface ConfigProviderResult {
  provider: 'auto' | 'gemini' | 'gateway' | 'bedrock' | 'openai';
  changed: boolean;
}

export interface ConfigModelResult {
  model: string | null;
  changed: boolean;
}

export interface ConfigMcpModeResult {
  mode: McpMode;
  changed: boolean;
}

export type AiDefaultTarget = 'create' | 'submit' | 'flow';
export type AiProvider = 'auto' | 'gemini' | 'gateway' | 'bedrock' | 'openai';
export type AiModelProvider = Exclude<AiProvider, 'auto'>;

export async function configAiAssistant(
  cwd: string,
  state?: string,
): Promise<ConfigBooleanResult> {
  const config = await readConfig(cwd);
  if (state == null) {
    return {
      enabled: config.aiAssistantEnabled,
      changed: false,
    };
  }

  const parsed = parseAiAssistantState(state);
  const changed = config.aiAssistantEnabled !== parsed;
  if (changed) {
    await writeConfig(
      {
        ...config,
        aiAssistantEnabled: parsed,
      },
      cwd,
    );
  }

  return {
    enabled: parsed,
    changed,
  };
}

export async function configAiDefaults(
  cwd: string,
  target: AiDefaultTarget,
  state?: string,
): Promise<ConfigBooleanResult> {
  const config = await readConfig(cwd);
  const key = resolveAiDefaultKey(target);

  if (state == null) {
    return {
      enabled: config.ai.defaults[key],
      changed: false,
    };
  }

  const parsed = parseAiAssistantState(state);
  const changed = config.ai.defaults[key] !== parsed;
  if (changed) {
    await writeConfig(
      {
        ...config,
        ai: {
          ...config.ai,
          defaults: {
            ...config.ai.defaults,
            [key]: parsed,
          },
        },
      },
      cwd,
    );
  }

  return {
    enabled: parsed,
    changed,
  };
}

export async function configAiProvider(
  cwd: string,
  provider?: string,
): Promise<ConfigProviderResult> {
  const config = await readConfig(cwd);
  if (provider == null) {
    return {
      provider: config.ai.provider.selected,
      changed: false,
    };
  }

  const parsed = parseAiProvider(provider);
  const changed = config.ai.provider.selected !== parsed;
  if (changed) {
    await writeConfig(
      {
        ...config,
        ai: {
          ...config.ai,
          provider: {
            ...config.ai.provider,
            selected: parsed,
          },
        },
      },
      cwd,
    );
  }

  return {
    provider: parsed,
    changed,
  };
}

export async function configAiModel(
  cwd: string,
  provider: string,
  model?: string,
  options: { clear?: boolean } = {},
): Promise<ConfigModelResult> {
  const config = await readConfig(cwd);
  const parsedProvider = parseAiModelProvider(provider);
  const current = config.ai.provider.models[parsedProvider];

  if (!options.clear && model == null) {
    return {
      model: current,
      changed: false,
    };
  }

  const next = options.clear ? null : normalizeModelOverride(model);
  const changed = current !== next;
  if (changed) {
    await writeConfig(
      {
        ...config,
        ai: {
          ...config.ai,
          provider: {
            ...config.ai.provider,
            models: {
              ...config.ai.provider.models,
              [parsedProvider]: next,
            },
          },
        },
      },
      cwd,
    );
  }

  return {
    model: next,
    changed,
  };
}

export async function configMcpMode(
  cwd: string,
  mode?: string,
): Promise<ConfigMcpModeResult> {
  const config = await readConfig(cwd);
  if (mode == null) {
    return {
      mode: config.mcpMode,
      changed: false,
    };
  }

  const parsed = parseMcpMode(mode);
  const changed = config.mcpMode !== parsed;
  if (changed) {
    await writeConfig(
      {
        ...config,
        mcpMode: parsed,
      },
      cwd,
    );
  }

  return {
    mode: parsed,
    changed,
  };
}

function parseMcpMode(value: string): McpMode {
  if (value === 'read-only' || value === 'interactive' || value === 'trusted') {
    return value;
  }
  throw new DubError(
    "MCP mode must be one of 'read-only', 'interactive', or 'trusted'.",
    [
      "Pass 'read-only' to disable mutating MCP tools.",
      "Pass 'interactive' to require terminal confirmation before mutating tools run (default).",
      "Pass 'trusted' to let mutating MCP tools run without confirmation.",
    ],
  );
}

function parseAiAssistantState(value: string): boolean {
  if (value === 'on') return true;
  if (value === 'off') return false;
  throw new DubError("Value must be either 'on' or 'off'.", [
    "Pass 'on' to enable or 'off' to disable.",
  ]);
}

function resolveAiDefaultKey(
  target: AiDefaultTarget,
): keyof DubConfig['ai']['defaults'] {
  if (target === 'create') return 'createMetadata';
  if (target === 'submit') return 'submitDescription';
  if (target === 'flow') return 'flow';
  throw new DubError(
    "Config target must be one of 'create', 'submit', or 'flow'.",
    ["Pass one of: 'create', 'submit', or 'flow' as the target."],
  );
}

function parseAiProvider(value: string): AiProvider {
  if (
    value === 'auto' ||
    value === 'gemini' ||
    value === 'gateway' ||
    value === 'bedrock' ||
    value === 'openai'
  ) {
    return value;
  }
  throw new DubError(
    "AI provider must be one of 'auto', 'gemini', 'gateway', 'bedrock', or 'openai'.",
    ["Pass one of: 'auto', 'gemini', 'gateway', 'bedrock', or 'openai'."],
  );
}

function parseAiModelProvider(value: string): AiModelProvider {
  if (
    value === 'gemini' ||
    value === 'gateway' ||
    value === 'bedrock' ||
    value === 'openai'
  ) {
    return value;
  }
  throw new DubError(
    "AI model provider must be one of 'gemini', 'gateway', 'bedrock', or 'openai'.",
    ["Pass one of: 'gemini', 'gateway', 'bedrock', or 'openai' as --provider."],
  );
}

function normalizeModelOverride(value: string | undefined): string {
  const model = value?.trim() ?? '';
  if (model.length === 0) {
    throw new DubError('Model override cannot be empty.', [
      'Pass a non-empty model identifier.',
      "Pass '--clear' instead to remove the override.",
    ]);
  }
  return model;
}
