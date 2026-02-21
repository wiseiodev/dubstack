import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestRepo } from '../../test/helpers';
import type { AiContext } from '../lib/ai-context';
import { writeConfig } from '../lib/config';
import { askAi } from './ai';

let dir: string;
let cleanup: () => Promise<void>;
let envSnapshot: NodeJS.ProcessEnv;

beforeEach(async () => {
  const repo = await createTestRepo();
  dir = repo.dir;
  cleanup = repo.cleanup;
  envSnapshot = { ...process.env };
});

afterEach(async () => {
  process.env = envSnapshot;
  await cleanup();
});

function streamFrom(chunks: string[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

function createOutputCapture() {
  const writes: string[] = [];
  return {
    writes,
    stream: {
      write(value: string | Uint8Array) {
        writes.push(typeof value === 'string' ? value : value.toString());
        return true;
      },
    },
  };
}

describe('askAi', () => {
  const fakeContext: AiContext = {
    generatedAt: '2026-02-21T00:00:00.000Z',
    currentBranch: 'feat/a',
    activeOperation: 'none',
    gitStatusShort: ['## feat/a...origin/feat/a'],
    stack: null,
    doctor: null,
    recentHistory: [],
  };

  it('requires ai assistant to be enabled in config', async () => {
    await expect(
      askAi('hello', dir, {
        output: createOutputCapture().stream,
      }),
    ).rejects.toThrow("Enable it with 'dub config ai-assistant on'.");
  });

  it('uses Google provider when DUBSTACK_GEMINI_API_KEY is set', async () => {
    await writeConfig({ aiAssistantEnabled: true }, dir);
    process.env.DUBSTACK_GEMINI_API_KEY = 'gem-key';
    process.env.DUBSTACK_AI_GATEWAY_API_KEY = 'gateway-key';

    const streamText = vi.fn().mockReturnValue({
      textStream: streamFrom(['hello']),
    });
    const googleModel = vi.fn().mockReturnValue('google-model');
    const createGoogleGenerativeAI = vi.fn().mockReturnValue(googleModel);
    const createGateway = vi.fn();
    const collectAiContext = vi.fn().mockResolvedValue(fakeContext);
    const output = createOutputCapture();

    const result = await askAi('Explain this stack', dir, {
      output: output.stream,
      deps: {
        streamText,
        createGoogleGenerativeAI,
        createGateway,
        collectAiContext,
      },
    });

    expect(createGoogleGenerativeAI).toHaveBeenCalledWith({
      apiKey: 'gem-key',
    });
    expect(googleModel).toHaveBeenCalledWith('gemini-3-flash');
    expect(createGateway).not.toHaveBeenCalled();
    expect(result.provider).toBe('google');
    expect(output.writes.join('')).toBe('hello\n');

    expect(streamText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'google-model',
        prompt: expect.stringContaining('Explain this stack'),
        system: expect.stringContaining('DubStack assistant'),
        providerOptions: {
          google: {
            thinkingConfig: {
              thinkingLevel: 'high',
            },
          },
        },
      }),
    );
  });

  it('uses AI Gateway provider when only DUBSTACK_AI_GATEWAY_API_KEY is set', async () => {
    await writeConfig({ aiAssistantEnabled: true }, dir);
    delete process.env.DUBSTACK_GEMINI_API_KEY;
    process.env.DUBSTACK_AI_GATEWAY_API_KEY = 'gateway-key';

    const streamText = vi.fn().mockReturnValue({
      textStream: streamFrom(['gateway']),
    });
    const createGoogleGenerativeAI = vi.fn();
    const gatewayModel = vi.fn().mockReturnValue('gateway-model');
    const createGateway = vi.fn().mockReturnValue(gatewayModel);
    const collectAiContext = vi.fn().mockResolvedValue(fakeContext);
    const output = createOutputCapture();

    const result = await askAi('Explain this stack', dir, {
      output: output.stream,
      deps: {
        streamText,
        createGoogleGenerativeAI,
        createGateway,
        collectAiContext,
      },
    });

    expect(createGoogleGenerativeAI).not.toHaveBeenCalled();
    expect(createGateway).toHaveBeenCalledWith({
      apiKey: 'gateway-key',
    });
    expect(gatewayModel).toHaveBeenCalledWith('google/gemini-3-flash');
    expect(result.provider).toBe('gateway');
    expect(output.writes.join('')).toBe('gateway\n');
  });

  it('requires at least one AI key environment variable', async () => {
    await writeConfig({ aiAssistantEnabled: true }, dir);
    delete process.env.DUBSTACK_GEMINI_API_KEY;
    delete process.env.DUBSTACK_AI_GATEWAY_API_KEY;

    await expect(
      askAi('hello', dir, {
        output: createOutputCapture().stream,
      }),
    ).rejects.toThrow('DUBSTACK_GEMINI_API_KEY or DUBSTACK_AI_GATEWAY_API_KEY');
  });
});
