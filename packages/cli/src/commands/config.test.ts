import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestRepo } from '../../test/helpers';
import { readConfig } from '../lib/config';
import { configAiAssistant, configAiDefaults } from './config';

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
