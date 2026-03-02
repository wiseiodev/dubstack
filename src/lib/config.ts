import * as fs from 'node:fs';
import * as path from 'node:path';
import { DubError } from './errors';
import { getDubDir } from './state';

export interface DubConfig {
  aiAssistantEnabled: boolean;
  ai: {
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

const DEFAULT_CONFIG: DubConfig = {
  aiAssistantEnabled: false,
  ai: {
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
    const parsed = JSON.parse(raw) as Partial<DubConfig>;
    return normalizeConfig(parsed);
  } catch {
    throw new DubError(
      "Config file is corrupted. Delete .git/dubstack/config.json or run 'dub config ai-assistant off' to reset it.",
    );
  }
}

export async function writeConfig(
  config: Partial<DubConfig>,
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

function normalizeConfig(config: Partial<DubConfig>): DubConfig {
  const fallback = config.ai?.shortcutFallback;
  const shellHistory = config.ai?.context?.shellHistory;
  const webBrowsing = config.ai?.webBrowsing;

  return {
    aiAssistantEnabled:
      typeof config.aiAssistantEnabled === 'boolean'
        ? config.aiAssistantEnabled
        : DEFAULT_CONFIG.aiAssistantEnabled,
    ai: {
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
