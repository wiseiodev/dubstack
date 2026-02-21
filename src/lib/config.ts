import * as fs from 'node:fs';
import * as path from 'node:path';
import { DubError } from './errors';
import { getDubDir } from './state';

export interface DubConfig {
  aiAssistantEnabled: boolean;
}

const DEFAULT_CONFIG: DubConfig = {
  aiAssistantEnabled: false,
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
  config: DubConfig,
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
  return {
    aiAssistantEnabled:
      typeof config.aiAssistantEnabled === 'boolean'
        ? config.aiAssistantEnabled
        : DEFAULT_CONFIG.aiAssistantEnabled,
  };
}
