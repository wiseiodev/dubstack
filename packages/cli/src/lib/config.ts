import * as fs from 'node:fs';
import * as path from 'node:path';
import { DubError } from './errors';
import { getDubDir } from './state';

export type McpMode = 'read-only' | 'interactive' | 'trusted';
export type StorageBackend = 'json' | 'sqlite';
export type SubmitDefault = 'auto' | 'draft' | 'publish';

export interface DubConfig {
  aiAssistantEnabled: boolean;
  mcpMode: McpMode;
  reviewers: string[];
  storageBackend: StorageBackend;
  submitDefault: SubmitDefault;
  ai: {
    defaults: {
      createMetadata: boolean;
      submitDescription: boolean;
      flow: boolean;
    };
    prompts: {
      mode: 'auto' | 'on' | 'off';
      autoAccept: 'off' | 'high';
    };
    provider: {
      selected:
        | 'auto'
        | 'gemini'
        | 'anthropic'
        | 'gateway'
        | 'bedrock'
        | 'openai'
        | 'ollama';
      models: {
        gemini: string | null;
        anthropic: string | null;
        gateway: string | null;
        bedrock: string | null;
        openai: string | null;
        ollama: string | null;
      };
    };
    shortcutFallback: {
      enabled: boolean;
      typoGuard: 'interactive';
      nonTtyPolicy: 'error-with-suggestion';
    };
    context: {
      shellHistory: {
        enabled: boolean;
        maxCommands: number;
      };
    };
    webBrowsing: {
      mode: 'model-native';
      fallback: 'graceful';
    };
  };
}

type DeepPartial<T> =
  T extends Array<infer U>
    ? Array<DeepPartial<U>>
    : T extends object
      ? { [K in keyof T]?: DeepPartial<T[K]> }
      : T;

const DEFAULT_CONFIG: DubConfig = {
  aiAssistantEnabled: false,
  mcpMode: 'interactive',
  reviewers: [],
  storageBackend: 'json',
  submitDefault: 'auto',
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
      selected: 'auto',
      models: {
        gemini: null,
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

export async function getConfigPath(cwd: string): Promise<string> {
  const dubDir = await getDubDir(cwd);
  return path.join(dubDir, 'config.json');
}

export async function readConfig(cwd: string): Promise<DubConfig> {
  const configPath = await getConfigPath(cwd);
  if (!fs.existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as DeepPartial<DubConfig>;
    return normalizeConfig(parsed);
  } catch {
    throw new DubError('Config file is corrupted.', [
      "Run 'rm .git/dubstack/config.json' to delete the corrupted file.",
      "Run 'dub config ai-assistant off' to reset the configuration.",
    ]);
  }
}

export async function writeConfig(
  config: DeepPartial<DubConfig>,
  cwd: string,
): Promise<void> {
  const configPath = await getConfigPath(cwd);
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const normalized = normalizeConfig(config);
  fs.writeFileSync(configPath, `${JSON.stringify(normalized, null, 2)}\n`);
}

function normalizeConfig(config: DeepPartial<DubConfig>): DubConfig {
  const defaults = config.ai?.defaults;
  const prompts = config.ai?.prompts;
  const provider = config.ai?.provider;
  const fallback = config.ai?.shortcutFallback;
  const shellHistory = config.ai?.context?.shellHistory;
  const webBrowsing = config.ai?.webBrowsing;

  return {
    aiAssistantEnabled:
      typeof config.aiAssistantEnabled === 'boolean'
        ? config.aiAssistantEnabled
        : DEFAULT_CONFIG.aiAssistantEnabled,
    mcpMode: normalizeMcpMode(config.mcpMode),
    reviewers: normalizeReviewers(config.reviewers),
    storageBackend: normalizeStorageBackend(config.storageBackend),
    submitDefault: normalizeSubmitDefault(config.submitDefault),
    ai: {
      defaults: {
        createMetadata:
          typeof defaults?.createMetadata === 'boolean'
            ? defaults.createMetadata
            : DEFAULT_CONFIG.ai.defaults.createMetadata,
        submitDescription:
          typeof defaults?.submitDescription === 'boolean'
            ? defaults.submitDescription
            : DEFAULT_CONFIG.ai.defaults.submitDescription,
        flow:
          typeof defaults?.flow === 'boolean'
            ? defaults.flow
            : DEFAULT_CONFIG.ai.defaults.flow,
      },
      prompts: {
        mode: normalizeAiPromptMode(prompts?.mode),
        autoAccept: normalizeAiPromptAutoAccept(prompts?.autoAccept),
      },
      provider: {
        selected: normalizeAiProviderSelection(provider?.selected),
        models: {
          gemini: normalizeAiProviderModel(provider?.models?.gemini),
          anthropic: normalizeAiProviderModel(provider?.models?.anthropic),
          gateway: normalizeAiProviderModel(provider?.models?.gateway),
          bedrock: normalizeAiProviderModel(provider?.models?.bedrock),
          openai: normalizeAiProviderModel(provider?.models?.openai),
          ollama: normalizeAiProviderModel(provider?.models?.ollama),
        },
      },
      shortcutFallback: {
        enabled:
          typeof fallback?.enabled === 'boolean'
            ? fallback.enabled
            : DEFAULT_CONFIG.ai.shortcutFallback.enabled,
        typoGuard:
          fallback?.typoGuard === 'interactive'
            ? fallback.typoGuard
            : DEFAULT_CONFIG.ai.shortcutFallback.typoGuard,
        nonTtyPolicy:
          fallback?.nonTtyPolicy === 'error-with-suggestion'
            ? fallback.nonTtyPolicy
            : DEFAULT_CONFIG.ai.shortcutFallback.nonTtyPolicy,
      },
      context: {
        shellHistory: {
          enabled:
            typeof shellHistory?.enabled === 'boolean'
              ? shellHistory.enabled
              : DEFAULT_CONFIG.ai.context.shellHistory.enabled,
          maxCommands:
            Number.isInteger(shellHistory?.maxCommands) &&
            (shellHistory?.maxCommands ?? 0) > 0
              ? (shellHistory?.maxCommands as number)
              : DEFAULT_CONFIG.ai.context.shellHistory.maxCommands,
        },
      },
      webBrowsing: {
        mode:
          webBrowsing?.mode === 'model-native'
            ? webBrowsing.mode
            : DEFAULT_CONFIG.ai.webBrowsing.mode,
        fallback:
          webBrowsing?.fallback === 'graceful'
            ? webBrowsing.fallback
            : DEFAULT_CONFIG.ai.webBrowsing.fallback,
      },
    },
  };
}

function normalizeReviewers(value: unknown): string[] {
  if (!Array.isArray(value)) return DEFAULT_CONFIG.reviewers;
  return value.filter((entry): entry is string => {
    return typeof entry === 'string' && entry.trim().length > 0;
  });
}

function normalizeStorageBackend(value: unknown): StorageBackend {
  if (value === 'json' || value === 'sqlite') return value;
  return DEFAULT_CONFIG.storageBackend;
}

function normalizeAiPromptMode(
  value: unknown,
): DubConfig['ai']['prompts']['mode'] {
  if (value === 'auto' || value === 'on' || value === 'off') {
    return value;
  }
  return DEFAULT_CONFIG.ai.prompts.mode;
}

function normalizeAiPromptAutoAccept(
  value: unknown,
): DubConfig['ai']['prompts']['autoAccept'] {
  if (value === 'off' || value === 'high') {
    return value;
  }
  return DEFAULT_CONFIG.ai.prompts.autoAccept;
}

function normalizeAiProviderSelection(
  value: unknown,
): DubConfig['ai']['provider']['selected'] {
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
  return DEFAULT_CONFIG.ai.provider.selected;
}

function normalizeMcpMode(value: unknown): McpMode {
  if (value === 'read-only' || value === 'interactive' || value === 'trusted') {
    return value;
  }
  return DEFAULT_CONFIG.mcpMode;
}

function normalizeSubmitDefault(value: unknown): SubmitDefault {
  if (value === 'auto' || value === 'draft' || value === 'publish') {
    return value;
  }
  return DEFAULT_CONFIG.submitDefault;
}

function normalizeAiProviderModel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const model = value.trim();
  return model.length > 0 ? model : null;
}
