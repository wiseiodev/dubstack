import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configureAiEnv } from './ai-env';

let tempDir: string;
let envSnapshot: NodeJS.ProcessEnv;

beforeEach(async () => {
  envSnapshot = { ...process.env };
  tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dub-ai-env-'));
});

afterEach(async () => {
  process.env = envSnapshot;
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
    expect(result.activationCommand).toBe(`source '${profile}'`);
    expect(process.env.DUBSTACK_GEMINI_API_KEY).toBe('gemini-secret');
    expect(updated).toContain("export DUBSTACK_GEMINI_API_KEY='gemini-secret'");
  });

  it('updates existing exports instead of duplicating', async () => {
    const profile = path.join(tempDir, '.bashrc');
    await fs.promises.writeFile(
      profile,
      [
        "export DUBSTACK_GEMINI_API_KEY='old'",
        "export DUBSTACK_AI_GATEWAY_API_KEY='old'",
        "export DUBSTACK_OPENAI_API_KEY='old'",
        "export DUBSTACK_OLLAMA_BASE_URL='http://localhost:11434'",
        '',
      ].join('\n'),
    );

    await configureAiEnv({
      geminiKey: 'new-gemini',
      gatewayKey: 'new-gateway',
      openaiKey: 'new-openai',
      ollamaBaseUrl: 'http://localhost:11435',
      profile,
    });
    const updated = await fs.promises.readFile(profile, 'utf8');

    expect(updated.match(/DUBSTACK_GEMINI_API_KEY/g)?.length).toBe(1);
    expect(updated.match(/DUBSTACK_AI_GATEWAY_API_KEY/g)?.length).toBe(1);
    expect(updated.match(/DUBSTACK_OPENAI_API_KEY/g)?.length).toBe(1);
    expect(updated.match(/DUBSTACK_OLLAMA_BASE_URL/g)?.length).toBe(1);
    expect(updated).toContain("export DUBSTACK_GEMINI_API_KEY='new-gemini'");
    expect(updated).toContain(
      "export DUBSTACK_AI_GATEWAY_API_KEY='new-gateway'",
    );
    expect(updated).toContain("export DUBSTACK_OPENAI_API_KEY='new-openai'");
    expect(updated).toContain(
      "export DUBSTACK_OLLAMA_BASE_URL='http://localhost:11435'",
    );
  });

  it('writes model exports without keys', async () => {
    const profile = path.join(tempDir, '.zshrc');
    await fs.promises.writeFile(profile, '# existing\n');

    const result = await configureAiEnv({
      geminiModel: 'gemini-2.5-flash',
      anthropicModel: 'claude-sonnet-4-20250514',
      gatewayModel: 'google/gemini-3-flash',
      openaiModel: 'gpt-5.5',
      ollamaModel: 'qwen2.5-coder',
      profile,
    });
    const updated = await fs.promises.readFile(profile, 'utf8');

    expect(result.updated).toEqual([
      'DUBSTACK_GEMINI_MODEL',
      'DUBSTACK_ANTHROPIC_MODEL',
      'DUBSTACK_AI_GATEWAY_MODEL',
      'DUBSTACK_OPENAI_MODEL',
      'DUBSTACK_OLLAMA_MODEL',
    ]);
    expect(updated).toContain(
      "export DUBSTACK_GEMINI_MODEL='gemini-2.5-flash'",
    );
    expect(updated).toContain(
      "export DUBSTACK_ANTHROPIC_MODEL='claude-sonnet-4-20250514'",
    );
    expect(updated).toContain(
      "export DUBSTACK_AI_GATEWAY_MODEL='google/gemini-3-flash'",
    );
    expect(updated).toContain("export DUBSTACK_OPENAI_MODEL='gpt-5.5'");
    expect(updated).toContain("export DUBSTACK_OLLAMA_MODEL='qwen2.5-coder'");
  });

  it('writes OpenAI key and model exports', async () => {
    const profile = path.join(tempDir, '.zshrc');
    await fs.promises.writeFile(profile, '# existing\n');

    const result = await configureAiEnv({
      openaiKey: 'openai-secret',
      openaiModel: 'gpt-5.5',
      profile,
    });
    const updated = await fs.promises.readFile(profile, 'utf8');

    expect(result.updated).toEqual([
      'DUBSTACK_OPENAI_API_KEY',
      'DUBSTACK_OPENAI_MODEL',
    ]);
    expect(updated).toContain("export DUBSTACK_OPENAI_API_KEY='openai-secret'");
    expect(updated).toContain("export DUBSTACK_OPENAI_MODEL='gpt-5.5'");
    expect(process.env.DUBSTACK_OPENAI_API_KEY).toBe('openai-secret');
    expect(process.env.DUBSTACK_OPENAI_MODEL).toBe('gpt-5.5');
  });

  it('writes Ollama base URL and model exports', async () => {
    const profile = path.join(tempDir, '.zshrc');
    await fs.promises.writeFile(profile, '# existing\n');

    const result = await configureAiEnv({
      ollamaBaseUrl: 'http://localhost:11434/',
      ollamaModel: 'llama3.1',
      profile,
    });
    const updated = await fs.promises.readFile(profile, 'utf8');

    expect(result.updated).toEqual([
      'DUBSTACK_OLLAMA_BASE_URL',
      'DUBSTACK_OLLAMA_MODEL',
    ]);
    expect(updated).toContain(
      "export DUBSTACK_OLLAMA_BASE_URL='http://localhost:11434'",
    );
    expect(updated).toContain("export DUBSTACK_OLLAMA_MODEL='llama3.1'");
    expect(process.env.DUBSTACK_OLLAMA_BASE_URL).toBe('http://localhost:11434');
    expect(process.env.DUBSTACK_OLLAMA_MODEL).toBe('llama3.1');
  });

  it('writes Anthropic key and model exports', async () => {
    const profile = path.join(tempDir, '.zshrc');
    await fs.promises.writeFile(profile, '# existing\n');

    const result = await configureAiEnv({
      anthropicKey: 'anthropic-secret',
      anthropicModel: 'claude-opus-4-20250514',
      profile,
    });
    const updated = await fs.promises.readFile(profile, 'utf8');

    expect(result.updated).toEqual([
      'DUBSTACK_ANTHROPIC_API_KEY',
      'DUBSTACK_ANTHROPIC_MODEL',
    ]);
    expect(updated).toContain(
      "export DUBSTACK_ANTHROPIC_API_KEY='anthropic-secret'",
    );
    expect(updated).toContain(
      "export DUBSTACK_ANTHROPIC_MODEL='claude-opus-4-20250514'",
    );
    expect(process.env.DUBSTACK_ANTHROPIC_API_KEY).toBe('anthropic-secret');
    expect(process.env.DUBSTACK_ANTHROPIC_MODEL).toBe('claude-opus-4-20250514');
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

  it('writes Bedrock profile, region, and model exports', async () => {
    const profile = path.join(tempDir, '.zshrc');
    await fs.promises.writeFile(profile, '# existing\n');

    const result = await configureAiEnv({
      bedrockProfile: 'bw-sso',
      bedrockRegion: 'us-west-2',
      bedrockModel: 'us.anthropic.claude-sonnet-4-6',
      profile,
    });
    const updated = await fs.promises.readFile(profile, 'utf8');

    expect(result.updated).toEqual([
      'DUBSTACK_BEDROCK_AWS_PROFILE',
      'DUBSTACK_BEDROCK_AWS_REGION',
      'DUBSTACK_BEDROCK_MODEL',
    ]);
    expect(updated).toContain("export DUBSTACK_BEDROCK_AWS_PROFILE='bw-sso'");
    expect(updated).toContain("export DUBSTACK_BEDROCK_AWS_REGION='us-west-2'");
    expect(updated).toContain(
      "export DUBSTACK_BEDROCK_MODEL='us.anthropic.claude-sonnet-4-6'",
    );
    expect(process.env.DUBSTACK_BEDROCK_AWS_PROFILE).toBe('bw-sso');
    expect(process.env.DUBSTACK_BEDROCK_AWS_REGION).toBe('us-west-2');
    expect(process.env.DUBSTACK_BEDROCK_MODEL).toBe(
      'us.anthropic.claude-sonnet-4-6',
    );
  });

  it('rejects empty Bedrock region values', async () => {
    const profile = path.join(tempDir, '.zshrc');
    await expect(
      configureAiEnv({ profile, bedrockRegion: '   ' }),
    ).rejects.toThrow('Bedrock region cannot be empty');
  });

  it('rejects empty model values', async () => {
    const profile = path.join(tempDir, '.zshrc');
    await expect(
      configureAiEnv({ profile, geminiModel: '   ' }),
    ).rejects.toThrow('Gemini model cannot be empty');
  });

  it('rejects empty Ollama base URLs', async () => {
    const profile = path.join(tempDir, '.zshrc');
    await expect(
      configureAiEnv({ profile, ollamaBaseUrl: '   ' }),
    ).rejects.toThrow('Ollama base URL cannot be empty');
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

  it('rejects gateway-style Anthropic model names', async () => {
    const profile = path.join(tempDir, '.zshrc');
    await expect(
      configureAiEnv({
        profile,
        anthropicModel: 'anthropic/claude-sonnet-4-20250514',
      }),
    ).rejects.toThrow("Anthropic model should not include '/'");
  });

  it('rejects gateway-style OpenAI model names', async () => {
    const profile = path.join(tempDir, '.zshrc');
    await expect(
      configureAiEnv({
        profile,
        openaiModel: 'openai/gpt-5.5',
      }),
    ).rejects.toThrow("OpenAI model should not include '/'");
  });

  it('throws when no key or model is provided', async () => {
    const profile = path.join(tempDir, '.zshrc');
    await expect(configureAiEnv({ profile })).rejects.toThrow(
      'Provide at least one key, model, or Bedrock setting',
    );
  });
});
