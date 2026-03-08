import { readConfig, writeConfig } from '../lib/config';
import { DubError } from '../lib/errors';

export interface ConfigAiAssistantResult {
  enabled: boolean;
  changed: boolean;
}

export async function configAiAssistant(
  cwd: string,
  state?: string,
): Promise<ConfigAiAssistantResult> {
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

function parseAiAssistantState(value: string): boolean {
  if (value === 'on') return true;
  if (value === 'off') return false;
  throw new DubError("Value must be either 'on' or 'off'.");
}
