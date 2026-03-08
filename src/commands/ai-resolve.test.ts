import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConflictContext } from '../lib/conflict-context';
import { DubError } from '../lib/errors';
import type { AiResolveDeps } from './ai-resolve';
import { aiResolve } from './ai-resolve';

function streamFrom(text: string) {
  return {
    fullStream: {
      async *[Symbol.asyncIterator]() {
        yield { type: 'text-delta' as const, text };
      },
    },
  };
}

function createMockContext(
  overrides?: Partial<ConflictContext>,
): ConflictContext {
  return {
    operation: 'rebase',
    conflictedBranch: 'feature-a',
    parentBranch: 'main',
    conflictedFiles: ['src/file.ts'],
    conflictMarkers: {
      'src/file.ts': '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> abc123',
    },
    upstreamCommits: 'abc123 upstream commit',
    replayedCommits: 'def456 replayed commit',
    ...overrides,
  };
}

function aiResponse(
  resolutions: Array<{
    path: string;
    resolvedContent: string;
    confidence: string;
    explanation: string;
  }>,
) {
  return streamFrom(JSON.stringify(resolutions));
}

function createMockDeps(overrides?: Partial<AiResolveDeps>): AiResolveDeps {
  const googleModel = vi.fn().mockReturnValue('fake-model');
  const defaultResolution = [
    {
      path: 'src/file.ts',
      resolvedContent: 'resolved content',
      confidence: 'high',
      explanation: 'merged both sides',
    },
  ];

  return {
    streamText: vi.fn().mockReturnValue(aiResponse(defaultResolution)),
    createGoogleGenerativeAI: vi.fn().mockReturnValue(googleModel),
    createGateway: vi.fn(),
    gatherConflictContext: vi.fn().mockResolvedValue(createMockContext()),
    renderBatchPreview: vi.fn(),
    promptBatchAction: vi.fn().mockResolvedValue('apply-all'),
    promptFileAction: vi.fn().mockResolvedValue('apply'),
    applyResolution: vi.fn().mockResolvedValue(undefined),
    showScopeWarning: vi.fn().mockResolvedValue(true),
    validateResolutionPaths: vi.fn(),
    continueCommand: vi.fn().mockResolvedValue({ continued: 'rebase' }),
    abortCommand: vi.fn().mockResolvedValue({ aborted: 'rebase' }),
    ...overrides,
  };
}

let envSnapshot: NodeJS.ProcessEnv;

beforeEach(() => {
  envSnapshot = { ...process.env };
  process.env.DUBSTACK_GEMINI_API_KEY = 'test-key';
  vi.clearAllMocks();
});

afterEach(() => {
  process.env = envSnapshot;
});

describe('aiResolve', () => {
  it('throws when no active operation', async () => {
    const deps = createMockDeps({
      gatherConflictContext: vi
        .fn()
        .mockRejectedValue(
          new DubError(
            'No active rebase or restack operation. Nothing to resolve.',
          ),
        ),
    });

    await expect(aiResolve('/tmp/test', {}, deps)).rejects.toThrow(
      'No active rebase or restack operation',
    );
  });

  it('dry-run shows preview without applying', async () => {
    const deps = createMockDeps();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await aiResolve('/tmp/test', { dryRun: true }, deps);

    expect(deps.renderBatchPreview).toHaveBeenCalled();
    expect(deps.applyResolution).not.toHaveBeenCalled();

    const output = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('Dry run');

    logSpy.mockRestore();
  });

  it('abort calls abortCommand', async () => {
    const deps = createMockDeps();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await aiResolve('/tmp/test', { abort: true }, deps);

    expect(deps.abortCommand).toHaveBeenCalledWith('/tmp/test');
    expect(deps.gatherConflictContext).not.toHaveBeenCalled();

    logSpy.mockRestore();
  });

  it('applies resolutions on apply-all', async () => {
    const context = createMockContext({
      conflictedFiles: ['a.ts', 'b.ts'],
      conflictMarkers: {
        'a.ts': '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>>',
        'b.ts': '<<<<<<< HEAD\nours2\n=======\ntheirs2\n>>>>>>>',
      },
    });
    const resolutions = [
      {
        path: 'a.ts',
        resolvedContent: 'resolved-a',
        confidence: 'high',
        explanation: 'merged',
      },
      {
        path: 'b.ts',
        resolvedContent: 'resolved-b',
        confidence: 'medium',
        explanation: 'combined',
      },
    ];
    const deps = createMockDeps({
      gatherConflictContext: vi.fn().mockResolvedValue(context),
      streamText: vi.fn().mockReturnValue(aiResponse(resolutions)),
      promptBatchAction: vi.fn().mockResolvedValue('apply-all'),
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await aiResolve('/tmp/test', {}, deps);

    expect(deps.applyResolution).toHaveBeenCalledTimes(2);
    expect(deps.applyResolution).toHaveBeenCalledWith(
      'a.ts',
      'resolved-a',
      '/tmp/test',
    );
    expect(deps.applyResolution).toHaveBeenCalledWith(
      'b.ts',
      'resolved-b',
      '/tmp/test',
    );

    logSpy.mockRestore();
  });

  it('scope warning — user aborts, skips AI', async () => {
    const context = createMockContext({
      scopeWarning: '15 conflicted files exceeds the 10-file threshold.',
    });
    const deps = createMockDeps({
      gatherConflictContext: vi.fn().mockResolvedValue(context),
      showScopeWarning: vi.fn().mockResolvedValue(false),
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await aiResolve('/tmp/test', {}, deps);

    expect(deps.showScopeWarning).toHaveBeenCalledWith(
      '15 conflicted files exceeds the 10-file threshold.',
    );
    expect(deps.streamText).not.toHaveBeenCalled();

    logSpy.mockRestore();
  });

  it('scope warning — user continues, proceeds to AI', async () => {
    const context = createMockContext({
      scopeWarning: '15 conflicted files exceeds the 10-file threshold.',
    });
    const deps = createMockDeps({
      gatherConflictContext: vi.fn().mockResolvedValue(context),
      showScopeWarning: vi.fn().mockResolvedValue(true),
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await aiResolve('/tmp/test', {}, deps);

    expect(deps.showScopeWarning).toHaveBeenCalled();
    expect(deps.streamText).toHaveBeenCalled();
    expect(deps.applyResolution).toHaveBeenCalled();

    logSpy.mockRestore();
  });

  it('review individually — apply some, skip some', async () => {
    const context = createMockContext({
      conflictedFiles: ['a.ts', 'b.ts'],
      conflictMarkers: {
        'a.ts': '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>>',
        'b.ts': '<<<<<<< HEAD\nours2\n=======\ntheirs2\n>>>>>>>',
      },
    });
    const resolutions = [
      {
        path: 'a.ts',
        resolvedContent: 'resolved-a',
        confidence: 'high',
        explanation: 'merged',
      },
      {
        path: 'b.ts',
        resolvedContent: 'resolved-b',
        confidence: 'medium',
        explanation: 'combined',
      },
    ];
    const deps = createMockDeps({
      gatherConflictContext: vi.fn().mockResolvedValue(context),
      streamText: vi.fn().mockReturnValue(aiResponse(resolutions)),
      promptBatchAction: vi.fn().mockResolvedValue('review'),
      promptFileAction: vi
        .fn()
        .mockResolvedValueOnce('apply')
        .mockResolvedValueOnce('skip'),
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await aiResolve('/tmp/test', {}, deps);

    expect(deps.applyResolution).toHaveBeenCalledTimes(1);
    expect(deps.applyResolution).toHaveBeenCalledWith(
      'a.ts',
      'resolved-a',
      '/tmp/test',
    );

    logSpy.mockRestore();
  });

  it('review individually — abort midway calls abortCommand', async () => {
    const context = createMockContext({
      conflictedFiles: ['a.ts', 'b.ts'],
      conflictMarkers: {
        'a.ts': '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>>',
        'b.ts': '<<<<<<< HEAD\nours2\n=======\ntheirs2\n>>>>>>>',
      },
    });
    const resolutions = [
      {
        path: 'a.ts',
        resolvedContent: 'resolved-a',
        confidence: 'high',
        explanation: 'merged',
      },
      {
        path: 'b.ts',
        resolvedContent: 'resolved-b',
        confidence: 'medium',
        explanation: 'combined',
      },
    ];
    const deps = createMockDeps({
      gatherConflictContext: vi.fn().mockResolvedValue(context),
      streamText: vi.fn().mockReturnValue(aiResponse(resolutions)),
      promptBatchAction: vi.fn().mockResolvedValue('review'),
      promptFileAction: vi.fn().mockResolvedValue('abort'),
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await aiResolve('/tmp/test', {}, deps);

    expect(deps.abortCommand).toHaveBeenCalledWith('/tmp/test');
    expect(deps.applyResolution).not.toHaveBeenCalled();

    logSpy.mockRestore();
  });

  it('hands back to user after 1 failed retry', async () => {
    const deps = createMockDeps({
      continueCommand: vi
        .fn()
        .mockRejectedValueOnce(new Error('conflict'))
        .mockRejectedValueOnce(new Error('conflict again')),
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await aiResolve('/tmp/test', {}, deps);

    const output = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('AI could not fully resolve the conflicts');
    expect(output).toContain('dub continue');

    logSpy.mockRestore();
  });
});
