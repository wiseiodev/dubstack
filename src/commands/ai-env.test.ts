import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configureAiEnv } from './ai-env';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dub-ai-env-'));
});

afterEach(async () => {
  await fs.promises.rm(tempDir, { recursive: true, force: true });
});

describe('configureAiEnv', () => {
  it('writes gemini key export into profile', async () => {
    const profile = path.join(tempDir, '.zshrc');
    await fs.promises.writeFile(profile, '# existing\n');

    const result = await configureAiEnv({
      geminiKey: 'gemini-secret',
      profile,
    });
    const updated = await fs.promises.readFile(profile, 'utf8');

    expect(result.profilePath).toBe(profile);
    expect(result.updated).toEqual(['DUBSTACK_GEMINI_API_KEY']);
    expect(updated).toContain("export DUBSTACK_GEMINI_API_KEY='gemini-secret'");
  });

  it('updates existing exports instead of duplicating', async () => {
    const profile = path.join(tempDir, '.bashrc');
    await fs.promises.writeFile(
      profile,
      [
        "export DUBSTACK_GEMINI_API_KEY='old'",
        "export DUBSTACK_AI_GATEWAY_API_KEY='old'",
        '',
      ].join('\n'),
    );

    await configureAiEnv({
      geminiKey: 'new-gemini',
      gatewayKey: 'new-gateway',
      profile,
    });
    const updated = await fs.promises.readFile(profile, 'utf8');

    expect(updated.match(/DUBSTACK_GEMINI_API_KEY/g)?.length).toBe(1);
    expect(updated.match(/DUBSTACK_AI_GATEWAY_API_KEY/g)?.length).toBe(1);
    expect(updated).toContain("export DUBSTACK_GEMINI_API_KEY='new-gemini'");
    expect(updated).toContain(
      "export DUBSTACK_AI_GATEWAY_API_KEY='new-gateway'",
    );
  });

  it('writes model exports without keys', async () => {
    const profile = path.join(tempDir, '.zshrc');
    await fs.promises.writeFile(profile, '# existing\n');

    const result = await configureAiEnv({
      geminiModel: 'gemini-2.5-flash',
      gatewayModel: 'google/gemini-3-flash',
      profile,
    });
    const updated = await fs.promises.readFile(profile, 'utf8');

    expect(result.updated).toEqual([
      'DUBSTACK_GEMINI_MODEL',
      'DUBSTACK_AI_GATEWAY_MODEL',
    ]);
    expect(updated).toContain(
      "export DUBSTACK_GEMINI_MODEL='gemini-2.5-flash'",
    );
    expect(updated).toContain(
      "export DUBSTACK_AI_GATEWAY_MODEL='google/gemini-3-flash'",
    );
  });

  it('updates key and model exports together', async () => {
    const profile = path.join(tempDir, '.bashrc');
    await fs.promises.writeFile(
      profile,
      "export DUBSTACK_GEMINI_MODEL='old'\n",
    );

    const result = await configureAiEnv({
      geminiKey: 'new-gemini-key',
      geminiModel: 'gemini-3-flash-preview',
      profile,
    });
    const updated = await fs.promises.readFile(profile, 'utf8');

    expect(result.updated).toEqual([
      'DUBSTACK_GEMINI_API_KEY',
      'DUBSTACK_GEMINI_MODEL',
    ]);
    expect(updated.match(/DUBSTACK_GEMINI_MODEL/g)?.length).toBe(1);
    expect(updated).toContain(
      "export DUBSTACK_GEMINI_API_KEY='new-gemini-key'",
    );
    expect(updated).toContain(
      "export DUBSTACK_GEMINI_MODEL='gemini-3-flash-preview'",
    );
  });

  it('rejects empty model values', async () => {
    const profile = path.join(tempDir, '.zshrc');
    await expect(
      configureAiEnv({ profile, geminiModel: '   ' }),
    ).rejects.toThrow('Gemini model cannot be empty');
  });

  it('rejects gateway-style Gemini model names', async () => {
    const profile = path.join(tempDir, '.zshrc');
    await expect(
      configureAiEnv({
        profile,
        geminiModel: 'google/gemini-2.5-pro',
      }),
    ).rejects.toThrow("Gemini model should not include '/'");
  });

  it('throws when no key or model is provided', async () => {
    const profile = path.join(tempDir, '.zshrc');
    await expect(configureAiEnv({ profile })).rejects.toThrow(
      'Provide at least one key or model',
    );
  });
});
