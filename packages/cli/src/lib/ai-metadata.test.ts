import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAiDiffContext } from './ai-diff-context';
import {
  generateCreateMetadata,
  generateFlowMetadata,
  generatePrDescriptionSummary,
} from './ai-metadata';
import type { DubConfig } from './config';
import { DubError } from './errors';

let envSnapshot: NodeJS.ProcessEnv;

beforeEach(() => {
  envSnapshot = { ...process.env };
});

afterEach(() => {
  process.env = envSnapshot;
});

function createProviderConfig(): DubConfig['ai']['provider'] {
  return {
    selected: 'auto',
    models: {
      gemini: null,
      gateway: null,
      bedrock: null,
      openai: null,
    },
  };
}

describe('generateCreateMetadata', () => {
  it('uses the Gemini provider when DUBSTACK_GEMINI_API_KEY is set', async () => {
    process.env.DUBSTACK_GEMINI_API_KEY = 'gem-key';

    const generateText = vi.fn().mockResolvedValue({
      text: '{"branch":"feat/example","message":"feat: example"}',
    });
    const googleModel = vi.fn().mockReturnValue('google-model');
    const createGoogleGenerativeAI = vi.fn().mockReturnValue(googleModel);
    const createGateway = vi.fn();

    const result = await generateCreateMetadata(
      'diff --git a/file b/file',
      {
        generateText,
        createGoogleGenerativeAI,
        createGateway,
      },
      {},
      createProviderConfig(),
    );

    expect(result).toEqual({
      branch: 'feat/example',
      message: 'feat: example',
    });
    expect(createGoogleGenerativeAI).toHaveBeenCalledWith({
      apiKey: 'gem-key',
    });
    expect(createGateway).not.toHaveBeenCalled();
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'google-model',
      }),
    );
  });

  it('falls back to the gateway provider when only the gateway key is set', async () => {
    delete process.env.DUBSTACK_GEMINI_API_KEY;
    process.env.DUBSTACK_AI_GATEWAY_API_KEY = 'gateway-key';

    const generateText = vi.fn().mockResolvedValue({
      text: '{"branch":"feat/example","message":"feat: example"}',
    });
    const createGoogleGenerativeAI = vi.fn();
    const gatewayModel = vi.fn().mockReturnValue('gateway-model');
    const createGateway = vi.fn().mockReturnValue(gatewayModel);

    await generateCreateMetadata(
      'diff --git a/file b/file',
      {
        generateText,
        createGoogleGenerativeAI,
        createGateway,
      },
      {},
      createProviderConfig(),
    );

    expect(createGoogleGenerativeAI).not.toHaveBeenCalled();
    expect(createGateway).toHaveBeenCalledWith({ apiKey: 'gateway-key' });
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gateway-model',
      }),
    );
  });

  it('uses the OpenAI provider when only the OpenAI key is set', async () => {
    delete process.env.DUBSTACK_GEMINI_API_KEY;
    delete process.env.DUBSTACK_AI_GATEWAY_API_KEY;
    process.env.DUBSTACK_OPENAI_API_KEY = 'openai-key';

    const generateText = vi.fn().mockResolvedValue({
      text: '{"branch":"feat/openai","message":"feat: openai"}',
    });
    const createGoogleGenerativeAI = vi.fn();
    const createGateway = vi.fn();
    const openAiModel = vi.fn().mockReturnValue('openai-model');
    const createOpenAI = vi.fn().mockReturnValue(openAiModel);

    const result = await generateCreateMetadata(
      'diff --git a/file b/file',
      {
        generateText,
        createGoogleGenerativeAI,
        createGateway,
        createOpenAI,
      },
      {},
      createProviderConfig(),
    );

    expect(result).toEqual({
      branch: 'feat/openai',
      message: 'feat: openai',
    });
    expect(createGoogleGenerativeAI).not.toHaveBeenCalled();
    expect(createGateway).not.toHaveBeenCalled();
    expect(createOpenAI).toHaveBeenCalledWith({ apiKey: 'openai-key' });
    expect(openAiModel).toHaveBeenCalledWith('gpt-5.5');
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'openai-model',
      }),
    );
  });

  it('throws when no AI provider keys are configured', async () => {
    delete process.env.DUBSTACK_GEMINI_API_KEY;
    delete process.env.DUBSTACK_AI_GATEWAY_API_KEY;

    await expect(
      generateCreateMetadata(
        'diff --git a/file b/file',
        {
          generateText: vi.fn(),
          createGoogleGenerativeAI: vi.fn(),
          createGateway: vi.fn(),
        },
        {},
        createProviderConfig(),
      ),
    ).rejects.toThrow(DubError);

    await expect(
      generateCreateMetadata(
        'diff --git a/file b/file',
        {
          generateText: vi.fn(),
          createGoogleGenerativeAI: vi.fn(),
          createGateway: vi.fn(),
        },
        {},
        createProviderConfig(),
      ),
    ).rejects.toThrow('AI assistant has no configured provider.');
  });

  it('throws when AI metadata is missing required fields', async () => {
    process.env.DUBSTACK_GEMINI_API_KEY = 'gem-key';

    await expect(
      generateCreateMetadata(
        'diff --git a/file b/file',
        {
          generateText: vi.fn().mockResolvedValue({
            text: '{"branch":"feat/example"}',
          }),
          createGoogleGenerativeAI: vi.fn().mockReturnValue(vi.fn()),
          createGateway: vi.fn(),
        },
        {},
        createProviderConfig(),
      ),
    ).rejects.toThrow("AI assistant metadata is missing 'message'.");
  });

  it('includes the commit template in the create prompt when provided', async () => {
    process.env.DUBSTACK_GEMINI_API_KEY = 'gem-key';
    const generateText = vi.fn().mockResolvedValue({
      text: '{"branch":"feat/example","message":"feat: example\\n\\n## Testing\\n- [x] added"}',
    });

    await generateCreateMetadata(
      'diff --git a/file b/file',
      {
        generateText,
        createGoogleGenerativeAI: vi.fn().mockReturnValue(vi.fn()),
        createGateway: vi.fn(),
      },
      {
        commitTemplate: 'feat(scope): summary\n\n## Testing\n- [ ] added',
      },
      createProviderConfig(),
    );

    const call = vi.mocked(generateText).mock.calls[0]?.[0];
    expect(String(call?.prompt ?? '')).toContain(
      'REPOSITORY_COMMIT_TEMPLATE_START',
    );
    expect(String(call?.prompt ?? '')).toContain('## Testing');
  });

  it('includes structured staged context so late runtime files are still emphasized', async () => {
    process.env.DUBSTACK_GEMINI_API_KEY = 'gem-key';
    const generateText = vi.fn().mockResolvedValue({
      text: '{"branch":"feat/flow-context","message":"feat: improve flow context"}',
    });

    await generateCreateMetadata(
      buildAiDiffContext({
        rawDiff: `diff --git a/README.md b/README.md
index 1111111..2222222 100644
--- a/README.md
+++ b/README.md
@@ -1,3 +1,7 @@
+Updated docs
diff --git a/packages/cli/src/commands/flow.ts b/packages/cli/src/commands/flow.ts
index 1111111..2222222 100644
--- a/packages/cli/src/commands/flow.ts
+++ b/packages/cli/src/commands/flow.ts
@@ -1,3 +1,9 @@
+const runtime = 'change';
`,
      }),
      {
        generateText,
        createGoogleGenerativeAI: vi.fn().mockReturnValue(vi.fn()),
        createGateway: vi.fn(),
      },
      {},
      createProviderConfig(),
    );

    const call = vi.mocked(generateText).mock.calls[0]?.[0];
    const prompt = String(call?.prompt ?? '');
    expect(prompt).toContain('Dominant category: runtime');
    expect(prompt).toContain('FULL_FILE_MANIFEST_START');
    expect(prompt).toContain('packages/cli/src/commands/flow.ts');
  });

  it('normalizes extra whitespace in the commit subject while preserving the body', async () => {
    process.env.DUBSTACK_GEMINI_API_KEY = 'gem-key';

    const result = await generateCreateMetadata(
      'diff --git a/file b/file',
      {
        generateText: vi.fn().mockResolvedValue({
          text: '{"branch":"feat/example","message":"feat:   example subject\\n\\n## Testing\\n- [x] added"}',
        }),
        createGoogleGenerativeAI: vi.fn().mockReturnValue(vi.fn()),
        createGateway: vi.fn(),
      },
      {},
      createProviderConfig(),
    );

    expect(result.message).toBe(
      'feat: example subject\n\n## Testing\n- [x] added',
    );
  });
});

describe('generatePrDescriptionSummary', () => {
  it('generates a markdown summary with the configured provider', async () => {
    process.env.DUBSTACK_GEMINI_API_KEY = 'gem-key';

    const generateText = vi.fn().mockResolvedValue({
      text: '## Summary\n\nAdds the new submit AI flow.',
    });
    const googleModel = vi.fn().mockReturnValue('google-model');
    const createGoogleGenerativeAI = vi.fn().mockReturnValue(googleModel);
    const createGateway = vi.fn();

    const result = await generatePrDescriptionSummary(
      {
        branch: 'feat/submit-ai',
        baseBranch: 'main',
        commitMessage: 'feat: add submit ai mode',
        diff: 'diff --git a/file b/file',
      },
      {
        generateText,
        createGoogleGenerativeAI,
        createGateway,
      },
      {},
      createProviderConfig(),
    );

    expect(result).toBe('## Summary\n\nAdds the new submit AI flow.');
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'google-model',
      }),
    );
  });

  it('rejects empty AI PR descriptions', async () => {
    process.env.DUBSTACK_GEMINI_API_KEY = 'gem-key';

    await expect(
      generatePrDescriptionSummary(
        {
          branch: 'feat/submit-ai',
          baseBranch: 'main',
          commitMessage: 'feat: add submit ai mode',
          diff: 'diff --git a/file b/file',
        },
        {
          generateText: vi.fn().mockResolvedValue({ text: '   ' }),
          createGoogleGenerativeAI: vi.fn().mockReturnValue(vi.fn()),
          createGateway: vi.fn(),
        },
        {},
        createProviderConfig(),
      ),
    ).rejects.toThrow('AI assistant generated an empty PR description.');
  });

  it('includes the pull request template in the PR prompt when provided', async () => {
    process.env.DUBSTACK_GEMINI_API_KEY = 'gem-key';
    const generateText = vi.fn().mockResolvedValue({
      text: '## Summary\n\nUses the existing template.',
    });

    await generatePrDescriptionSummary(
      {
        branch: 'feat/submit-ai',
        baseBranch: 'main',
        commitMessage: 'feat: add submit ai mode',
        diff: 'diff --git a/file b/file',
      },
      {
        generateText,
        createGoogleGenerativeAI: vi.fn().mockReturnValue(vi.fn()),
        createGateway: vi.fn(),
      },
      {
        prTemplate: '## Summary\n\n## Testing',
      },
      createProviderConfig(),
    );

    const call = vi.mocked(generateText).mock.calls[0]?.[0];
    expect(String(call?.prompt ?? '')).toContain(
      'REPOSITORY_PR_TEMPLATE_START',
    );
    expect(String(call?.prompt ?? '')).toContain('## Testing');
  });
});

describe('generateFlowMetadata', () => {
  it('generates branch, commit message, and pr description from the same staged diff', async () => {
    process.env.DUBSTACK_GEMINI_API_KEY = 'gem-key';

    const generateText = vi
      .fn()
      .mockResolvedValueOnce({
        text: '{"branch":"feat/flow-example","message":"feat: add flow example"}',
      })
      .mockResolvedValueOnce({
        text: '## Summary\n\nAdds the flow example.',
      });
    const googleModel = vi.fn().mockReturnValue('google-model');
    const createGoogleGenerativeAI = vi.fn().mockReturnValue(googleModel);
    const createGateway = vi.fn();

    const result = await generateFlowMetadata(
      {
        parentBranch: 'main',
        staged: buildAiDiffContext({ rawDiff: 'diff --git a/file b/file' }),
      },
      {
        generateText,
        createGoogleGenerativeAI,
        createGateway,
      },
      {},
      createProviderConfig(),
    );

    expect(result).toEqual({
      branch: 'feat/flow-example',
      commitMessage: 'feat: add flow example',
      prDescription: '## Summary\n\nAdds the flow example.',
    });
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  it('passes commit and pr templates through to the underlying prompts', async () => {
    process.env.DUBSTACK_GEMINI_API_KEY = 'gem-key';

    const generateText = vi
      .fn()
      .mockResolvedValueOnce({
        text: '{"branch":"feat/templated","message":"feat: templated\\n\\n## Testing\\n- [x] added"}',
      })
      .mockResolvedValueOnce({
        text: '## Summary\n\n## Testing\n- [x] added',
      });

    await generateFlowMetadata(
      {
        parentBranch: 'main',
        staged: buildAiDiffContext({ rawDiff: 'diff --git a/file b/file' }),
      },
      {
        generateText,
        createGoogleGenerativeAI: vi.fn().mockReturnValue(vi.fn()),
        createGateway: vi.fn(),
      },
      {
        commitTemplate: 'feat(scope): summary\n\n## Testing\n- [ ] added',
        prTemplate: '## Summary\n\n## Testing',
      },
      createProviderConfig(),
    );

    const createCall = vi.mocked(generateText).mock.calls[0]?.[0];
    const prCall = vi.mocked(generateText).mock.calls[1]?.[0];
    expect(String(createCall?.prompt ?? '')).toContain(
      'REPOSITORY_COMMIT_TEMPLATE_START',
    );
    expect(String(prCall?.prompt ?? '')).toContain(
      'REPOSITORY_PR_TEMPLATE_START',
    );
  });
});
