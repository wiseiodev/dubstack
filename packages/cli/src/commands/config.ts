import type { DubConfig, McpMode, SubmitDefault } from '../lib/config';
import { readConfig, writeConfig } from '../lib/config';
import { DubError } from '../lib/errors';

export interface ConfigBooleanResult {
  enabled: boolean;
  changed: boolean;
}

export interface ConfigProviderResult {
  provider: AiProvider;
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

export interface ConfigSubmitDefaultResult {
  mode: SubmitDefault;
  changed: boolean;
}

export interface ConfigAiPromptsResult {
  mode: 'auto' | 'on' | 'off';
  changed: boolean;
}

export interface ConfigAiPromptsAutoAcceptResult {
  autoAccept: 'off' | 'high';
  changed: boolean;
}

export type AiDefaultTarget = 'create' | 'submit' | 'flow';
export type AiProvider =
  | 'auto'
  | 'gemini'
  | 'anthropic'
  | 'gateway'
  | 'bedrock'
  | 'openai'
  | 'ollama';
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

export async function configAiPrompts(
  cwd: string,
  mode?: string,
): Promise<ConfigAiPromptsResult> {
  const config = await readConfig(cwd);
  if (mode == null) {
    return {
      mode: config.ai.prompts.mode,
      changed: false,
    };
  }

  const parsed = parseAiPromptMode(mode);
  const changed = config.ai.prompts.mode !== parsed;
  if (changed) {
    await writeConfig(
      {
        ...config,
        ai: {
          ...config.ai,
          prompts: {
            ...config.ai.prompts,
            mode: parsed,
          },
        },
      },
      cwd,
    );
  }

  return {
    mode: parsed,
    changed,
  };
}

export async function configAiPromptsAutoAccept(
  cwd: string,
  autoAccept?: string,
): Promise<ConfigAiPromptsAutoAcceptResult> {
  const config = await readConfig(cwd);
  if (autoAccept == null) {
    return {
      autoAccept: config.ai.prompts.autoAccept,
      changed: false,
    };
  }

  const parsed = parseAiPromptAutoAccept(autoAccept);
  const changed = config.ai.prompts.autoAccept !== parsed;
  if (changed) {
    await writeConfig(
      {
        ...config,
        ai: {
          ...config.ai,
          prompts: {
            ...config.ai.prompts,
            autoAccept: parsed,
          },
        },
      },
      cwd,
    );
  }

  return {
    autoAccept: parsed,
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

export async function configSubmitDefault(
  cwd: string,
  mode?: string,
): Promise<ConfigSubmitDefaultResult> {
  const config = await readConfig(cwd);
  if (mode == null) {
    return {
      mode: config.submitDefault,
      changed: false,
    };
  }

  const parsed = parseSubmitDefault(mode);
  const changed = config.submitDefault !== parsed;
  if (changed) {
    await writeConfig(
      {
        ...config,
        submitDefault: parsed,
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

function parseSubmitDefault(value: string): SubmitDefault {
  if (value === 'auto' || value === 'draft' || value === 'publish') {
    return value;
  }
  throw new DubError(
    "Submit default must be one of 'auto', 'draft', or 'publish'.",
    [
      "Pass 'auto' to create draft PRs when CI workflows are configured.",
      "Pass 'draft' to create new submit PRs as drafts.",
      "Pass 'publish' to promote existing draft PRs by default.",
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

function parseAiPromptMode(value: string): 'auto' | 'on' | 'off' {
  if (value === 'auto' || value === 'on' || value === 'off') return value;
  throw new DubError("AI prompts must be one of 'auto', 'on', or 'off'.", [
    "Pass 'auto' to show AI prompt choices when the AI assistant is enabled.",
    "Pass 'on' to keep AI prompt choices enabled while the AI assistant is enabled.",
    "Pass 'off' to hide AI prompt choices.",
  ]);
}

function parseAiPromptAutoAccept(value: string): 'off' | 'high' {
  if (value === 'off' || value === 'high') return value;
  throw new DubError("AI prompt auto-accept must be either 'off' or 'high'.", [
    "Pass 'high' to apply high-confidence AI prompt recommendations without a confirmation prompt.",
    "Pass 'off' to always confirm AI prompt recommendations.",
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
    value === 'anthropic' ||
    value === 'gateway' ||
    value === 'bedrock' ||
    value === 'openai' ||
    value === 'ollama'
  ) {
    return value;
  }
  throw new DubError(
    "AI provider must be one of 'auto', 'gemini', 'anthropic', 'gateway', 'bedrock', 'openai', or 'ollama'.",
    [
      "Pass one of: 'auto', 'gemini', 'anthropic', 'gateway', 'bedrock', 'openai', or 'ollama'.",
    ],
  );
}

function parseAiModelProvider(value: string): AiModelProvider {
  if (
    value === 'gemini' ||
    value === 'anthropic' ||
    value === 'gateway' ||
    value === 'bedrock' ||
    value === 'openai' ||
    value === 'ollama'
  ) {
    return value;
  }
  throw new DubError(
    "AI model provider must be one of 'gemini', 'anthropic', 'gateway', 'bedrock', 'openai', or 'ollama'.",
    [
      "Pass one of: 'gemini', 'anthropic', 'gateway', 'bedrock', 'openai', or 'ollama' as --provider.",
    ],
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
