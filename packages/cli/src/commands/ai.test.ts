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
  return fullStreamFrom(
    chunks.map((chunk) => ({ type: 'text-delta' as const, text: chunk })),
  );
}

function fullStreamFrom(
  parts: Array<
    | { type: 'text-delta'; text: string }
    | { type: 'reasoning-start' }
    | { type: 'reasoning-delta'; text: string }
    | { type: 'reasoning-end' }
    | { type: 'error'; error: unknown }
  >,
) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const part of parts) {
        yield part;
      }
    },
  };
}

function createOutputCapture(options: { isTTY?: boolean } = {}) {
  const writes: string[] = [];
  return {
    writes,
    stream: {
      isTTY: options.isTTY ?? false,
      write(value: string | Uint8Array) {
        writes.push(typeof value === 'string' ? value : value.toString());
        return true;
      },
    },
  };
}

function createBashToolMock() {
  const bashTool = { id: 'bash-tool' } as const;
  const createBashTool = vi.fn().mockResolvedValue({
    tools: {
      bash: bashTool,
      readFile: { id: 'read-file-tool' },
      writeFile: { id: 'write-file-tool' },
    },
  });
  return { createBashTool, bashTool };
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
    recentShellHistory: [],
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
      fullStream: streamFrom(['hello']),
    });
    const googleModel = vi.fn().mockReturnValue('google-model');
    const createGoogleGenerativeAI = vi.fn().mockReturnValue(googleModel);
    const createGateway = vi.fn();
    const collectAiContext = vi.fn().mockResolvedValue(fakeContext);
    const { createBashTool, bashTool } = createBashToolMock();
    const output = createOutputCapture();

    const result = await askAi('Explain this stack', dir, {
      output: output.stream,
      deps: {
        streamText,
        createGoogleGenerativeAI,
        createGateway,
        collectAiContext,
        createBashTool,
      },
    });

    expect(createGoogleGenerativeAI).toHaveBeenCalledWith({
      apiKey: 'gem-key',
    });
    expect(googleModel).toHaveBeenCalledWith('gemini-3-flash-preview');
    expect(createGateway).not.toHaveBeenCalled();
    expect(createBashTool).toHaveBeenCalledWith(
      expect.objectContaining({
        destination: dir,
      }),
    );
    expect(result.provider).toBe('google');
    expect(output.writes.join('')).toBe('hello\n');

    expect(streamText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'google-model',
        prompt: expect.stringContaining('Explain this stack'),
        system: expect.stringContaining('DubStack assistant'),
        stopWhen: expect.any(Function),
        tools: {
          bash: bashTool,
        },
        providerOptions: {
          google: {
            thinkingConfig: {
              thinkingLevel: 'high',
              includeThoughts: true,
            },
            useSearchGrounding: true,
          },
        },
      }),
    );
  });

  it('uses DUBSTACK_GEMINI_MODEL override when provided', async () => {
    await writeConfig({ aiAssistantEnabled: true }, dir);
    process.env.DUBSTACK_GEMINI_API_KEY = 'gem-key';
    process.env.DUBSTACK_GEMINI_MODEL = 'gemini-2.5-pro-preview';
    delete process.env.DUBSTACK_AI_GATEWAY_API_KEY;

    const streamText = vi.fn().mockReturnValue({
      fullStream: streamFrom(['hello']),
    });
    const googleModel = vi.fn().mockReturnValue('google-model');
    const createGoogleGenerativeAI = vi.fn().mockReturnValue(googleModel);
    const createGateway = vi.fn();
    const collectAiContext = vi.fn().mockResolvedValue(fakeContext);
    const { createBashTool } = createBashToolMock();

    const result = await askAi('Explain this stack', dir, {
      output: createOutputCapture().stream,
      deps: {
        streamText,
        createGoogleGenerativeAI,
        createGateway,
        collectAiContext,
        createBashTool,
      },
    });

    expect(googleModel).toHaveBeenCalledWith('gemini-2.5-pro-preview');
    expect(result.modelId).toBe('gemini-2.5-pro-preview');
  });

  it('uses AI Gateway provider when only DUBSTACK_AI_GATEWAY_API_KEY is set', async () => {
    await writeConfig({ aiAssistantEnabled: true }, dir);
    delete process.env.DUBSTACK_GEMINI_API_KEY;
    process.env.DUBSTACK_AI_GATEWAY_API_KEY = 'gateway-key';

    const streamText = vi.fn().mockReturnValue({
      fullStream: streamFrom(['gateway']),
    });
    const createGoogleGenerativeAI = vi.fn();
    const gatewayModel = vi.fn().mockReturnValue('gateway-model');
    const createGateway = vi.fn().mockReturnValue(gatewayModel);
    const collectAiContext = vi.fn().mockResolvedValue(fakeContext);
    const { createBashTool } = createBashToolMock();
    const output = createOutputCapture();

    const result = await askAi('Explain this stack', dir, {
      output: output.stream,
      deps: {
        streamText,
        createGoogleGenerativeAI,
        createGateway,
        collectAiContext,
        createBashTool,
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

  it('uses DUBSTACK_AI_GATEWAY_MODEL override when provided', async () => {
    await writeConfig({ aiAssistantEnabled: true }, dir);
    delete process.env.DUBSTACK_GEMINI_API_KEY;
    process.env.DUBSTACK_AI_GATEWAY_API_KEY = 'gateway-key';
    process.env.DUBSTACK_AI_GATEWAY_MODEL = 'google/gemini-2.5-pro';

    const streamText = vi.fn().mockReturnValue({
      fullStream: streamFrom(['gateway']),
    });
    const createGoogleGenerativeAI = vi.fn();
    const gatewayModel = vi.fn().mockReturnValue('gateway-model');
    const createGateway = vi.fn().mockReturnValue(gatewayModel);
    const collectAiContext = vi.fn().mockResolvedValue(fakeContext);
    const { createBashTool } = createBashToolMock();

    const result = await askAi('Explain this stack', dir, {
      output: createOutputCapture().stream,
      deps: {
        streamText,
        createGoogleGenerativeAI,
        createGateway,
        collectAiContext,
        createBashTool,
      },
    });

    expect(gatewayModel).toHaveBeenCalledWith('google/gemini-2.5-pro');
    expect(result.modelId).toBe('google/gemini-2.5-pro');
  });

  it('streams a TTY thinking preview with spinner frames', async () => {
    await writeConfig({ aiAssistantEnabled: true }, dir);
    process.env.DUBSTACK_GEMINI_API_KEY = 'gem-key';
    delete process.env.DUBSTACK_AI_GATEWAY_API_KEY;

    const streamText = vi.fn().mockReturnValue({
      fullStream: fullStreamFrom([
        { type: 'reasoning-start' },
        { type: 'reasoning-delta', text: 'Planning edits' },
        { type: 'reasoning-delta', text: ' and checks' },
        { type: 'reasoning-end' },
        { type: 'text-delta', text: 'Done.' },
      ]),
    });
    const googleModel = vi.fn().mockReturnValue('google-model');
    const createGoogleGenerativeAI = vi.fn().mockReturnValue(googleModel);
    const createGateway = vi.fn();
    const collectAiContext = vi.fn().mockResolvedValue(fakeContext);
    const { createBashTool } = createBashToolMock();
    const output = createOutputCapture({ isTTY: true });

    await askAi('Explain this stack', dir, {
      output: output.stream,
      deps: {
        streamText,
        createGoogleGenerativeAI,
        createGateway,
        collectAiContext,
        createBashTool,
      },
    });

    const rendered = output.writes.join('');
    expect(rendered).toContain('thinking:');
    expect(rendered).toContain('\r');
    expect(rendered.endsWith('Done.\n')).toBe(true);
  });

  it('throws when the stream emits an error part', async () => {
    await writeConfig({ aiAssistantEnabled: true }, dir);
    process.env.DUBSTACK_GEMINI_API_KEY = 'gem-key';
    delete process.env.DUBSTACK_AI_GATEWAY_API_KEY;

    const streamText = vi.fn().mockReturnValue({
      fullStream: fullStreamFrom([{ type: 'error', error: new Error('boom') }]),
    });
    const googleModel = vi.fn().mockReturnValue('google-model');
    const createGoogleGenerativeAI = vi.fn().mockReturnValue(googleModel);
    const createGateway = vi.fn();
    const collectAiContext = vi.fn().mockResolvedValue(fakeContext);
    const { createBashTool } = createBashToolMock();

    await expect(
      askAi('Explain this stack', dir, {
        output: createOutputCapture().stream,
        deps: {
          streamText,
          createGoogleGenerativeAI,
          createGateway,
          collectAiContext,
          createBashTool,
        },
      }),
    ).rejects.toThrow('boom');
  });

  it('falls back gracefully when browsing options are unsupported', async () => {
    await writeConfig({ aiAssistantEnabled: true }, dir);
    process.env.DUBSTACK_GEMINI_API_KEY = 'gem-key';
    delete process.env.DUBSTACK_AI_GATEWAY_API_KEY;

    const streamText = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('unsupported provider option useSearchGrounding');
      })
      .mockReturnValueOnce({
        fullStream: streamFrom(['fallback answer']),
      });
    const googleModel = vi.fn().mockReturnValue('google-model');
    const createGoogleGenerativeAI = vi.fn().mockReturnValue(googleModel);
    const createGateway = vi.fn();
    const collectAiContext = vi.fn().mockResolvedValue(fakeContext);
    const { createBashTool } = createBashToolMock();
    const output = createOutputCapture();

    const result = await askAi('Explain this stack', dir, {
      output: output.stream,
      deps: {
        streamText,
        createGoogleGenerativeAI,
        createGateway,
        collectAiContext,
        createBashTool,
      },
    });

    expect(streamText).toHaveBeenCalledTimes(2);
    expect(output.writes.join('')).toContain('Web browsing is unavailable');
    expect(result.webBrowsingRequested).toBe(true);
    expect(result.webBrowsingUsed).toBe(false);
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
