import type { DubConfig } from '../lib/config';
import { readConfig, writeConfig } from '../lib/config';
import { DubError } from '../lib/errors';

export interface ConfigBooleanResult {
  enabled: boolean;
  changed: boolean;
}

export type AiDefaultTarget = 'create' | 'submit' | 'flow';

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
