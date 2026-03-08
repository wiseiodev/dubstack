import type { DubConfig } from '../lib/config';
import { readConfig, writeConfig } from '../lib/config';
import { DubError } from '../lib/errors';

export interface ConfigBooleanResult {
  enabled: boolean;
  changed: boolean;
}

export interface ConfigProviderResult {
  provider: 'auto' | 'gemini' | 'gateway' | 'bedrock';
  changed: boolean;
}

export interface ConfigModelResult {
  model: string | null;
  changed: boolean;
}

export type AiDefaultTarget = 'create' | 'submit' | 'flow';
export type AiProvider = 'auto' | 'gemini' | 'gateway' | 'bedrock';
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

function parseAiAssistantState(value: string): boolean {
  if (value === 'on') return true;
  if (value === 'off') return false;
  throw new DubError("Value must be either 'on' or 'off'.");
}

function resolveAiDefaultKey(
  target: AiDefaultTarget,
): keyof DubConfig['ai']['defaults'] {
  if (target === 'create') return 'createMetadata';
  if (target === 'submit') return 'submitDescription';
  if (target === 'flow') return 'flow';
  throw new DubError(
    "Config target must be one of 'create', 'submit', or 'flow'.",
  );
}

function parseAiProvider(value: string): AiProvider {
  if (
    value === 'auto' ||
    value === 'gemini' ||
    value === 'gateway' ||
    value === 'bedrock'
  ) {
    return value;
  }
  throw new DubError(
    "AI provider must be one of 'auto', 'gemini', 'gateway', or 'bedrock'.",
  );
}

function parseAiModelProvider(value: string): AiModelProvider {
  if (value === 'gemini' || value === 'gateway' || value === 'bedrock') {
    return value;
  }
  throw new DubError(
    "AI model provider must be one of 'gemini', 'gateway', or 'bedrock'.",
  );
}

function normalizeModelOverride(value: string | undefined): string {
  const model = value?.trim() ?? '';
  if (model.length === 0) {
    throw new DubError('Model override cannot be empty.');
  }
  return model;
}
