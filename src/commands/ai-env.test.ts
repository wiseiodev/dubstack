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

  it('throws when no key is provided', async () => {
    const profile = path.join(tempDir, '.zshrc');
    await expect(configureAiEnv({ profile })).rejects.toThrow(
      'Provide at least one key',
    );
  });
});
