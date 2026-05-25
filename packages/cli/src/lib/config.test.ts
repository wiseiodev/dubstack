import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestRepo } from '../../test/helpers';
import { readConfig, writeConfig } from './config';
import { DubError } from './errors';

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

describe('readConfig', () => {
  it('returns defaults when config file is missing', async () => {
    const config = await readConfig(dir);
    expect(config).toEqual({
      aiAssistantEnabled: false,
      mcpMode: 'interactive',
      reviewers: [],
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
    });
  });

  it('throws actionable error on invalid json', async () => {
    const dubDir = path.join(dir, '.git', 'dubstack');
    fs.mkdirSync(dubDir, { recursive: true });
    fs.writeFileSync(path.join(dubDir, 'config.json'), 'not-json');

    await expect(readConfig(dir)).rejects.toThrow(DubError);
    await expect(readConfig(dir)).rejects.toThrow('Config file is corrupted');
  });
});

describe('writeConfig', () => {
  it('persists and reloads config', async () => {
    await writeConfig({ aiAssistantEnabled: true }, dir);
    const config = await readConfig(dir);
    expect(config.aiAssistantEnabled).toBe(true);
    expect(config.submitDefault).toBe('auto');
    expect(config.ai.defaults).toEqual({
      createMetadata: false,
      submitDescription: false,
      flow: false,
    });
    expect(config.reviewers).toEqual([]);
    expect(config.ai.prompts).toEqual({
      mode: 'auto',
      autoAccept: 'off',
    });
    expect(config.ai.provider).toEqual({
      selected: 'auto',
      models: {
        gemini: null,
        anthropic: null,
        gateway: null,
        bedrock: null,
        openai: null,
        ollama: null,
      },
    });
  });

  it('fills in missing ai defaults when persisting partial config', async () => {
    await writeConfig(
      {
        ai: {
          defaults: {
            createMetadata: true,
            submitDescription: false,
            flow: false,
          },
        },
      },
      dir,
    );

    const config = await readConfig(dir);

    expect(config.ai.defaults).toEqual({
      createMetadata: true,
      submitDescription: false,
      flow: false,
    });
    expect(config.ai.prompts).toEqual({
      mode: 'auto',
      autoAccept: 'off',
    });
    expect(config.ai.provider).toEqual({
      selected: 'auto',
      models: {
        gemini: null,
        anthropic: null,
        gateway: null,
        bedrock: null,
        openai: null,
        ollama: null,
      },
    });
  });

  it('persists ai provider selection and per-provider model overrides', async () => {
    await writeConfig(
      {
        ai: {
          provider: {
            selected: 'bedrock',
            models: {
              anthropic: 'claude-sonnet-4-20250514',
            },
          },
        },
      },
      dir,
    );

    const config = await readConfig(dir);

    expect(config.ai.provider).toEqual({
      selected: 'bedrock',
      models: {
        gemini: null,
        anthropic: 'claude-sonnet-4-20250514',
        gateway: null,
        bedrock: null,
        openai: null,
        ollama: null,
      },
    });
  });

  it('persists ai prompt settings', async () => {
    await writeConfig(
      {
        ai: {
          prompts: {
            mode: 'on',
            autoAccept: 'high',
          },
        },
      },
      dir,
    );

    const config = await readConfig(dir);

    expect(config.ai.prompts).toEqual({
      mode: 'on',
      autoAccept: 'high',
    });
  });

  it('persists reviewer defaults', async () => {
    await writeConfig({ reviewers: ['alice', '@org/team'] }, dir);

    const config = await readConfig(dir);

    expect(config.reviewers).toEqual(['alice', '@org/team']);
  });

  it('persists submit lifecycle defaults', async () => {
    await writeConfig(
      {
        submitDefault: 'publish',
      },
      dir,
    );

    const config = await readConfig(dir);

    expect(config.submitDefault).toBe('publish');
  });

  it('normalizes invalid provider settings back to defaults', async () => {
    const dubDir = path.join(dir, '.git', 'dubstack');
    fs.mkdirSync(dubDir, { recursive: true });
    fs.writeFileSync(
      path.join(dubDir, 'config.json'),
      JSON.stringify({
        ai: {
          prompts: {
            mode: 'sometimes',
            autoAccept: 'medium',
          },
          provider: {
            selected: 'unknown',
            models: {
              gemini: 123,
              anthropic: 'claude-sonnet-4-20250514',
              gateway: '',
              bedrock: '   ',
              openai: '   ',
              ollama: 'qwen2.5-coder',
            },
          },
        },
        reviewers: ['alice', '', 123],
        submitDefault: 'ready',
      }),
    );

    const config = await readConfig(dir);

    expect(config.reviewers).toEqual(['alice']);
    expect(config.submitDefault).toBe('auto');
    expect(config.ai.prompts).toEqual({
      mode: 'auto',
      autoAccept: 'off',
    });
    expect(config.ai.provider).toEqual({
      selected: 'auto',
      models: {
        gemini: null,
        anthropic: 'claude-sonnet-4-20250514',
        gateway: null,
        bedrock: null,
        openai: null,
        ollama: 'qwen2.5-coder',
      },
    });
  });
});
