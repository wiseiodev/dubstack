import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestRepo, gitInRepo } from '../../test/helpers';
import { writeConfig } from '../lib/config';
import { getBranchTip, getCurrentBranch } from '../lib/git';
import { readState } from '../lib/state';
import { readUndoEntry } from '../lib/undo-log';
import { create } from './create';
import { init } from './init';

let dir: string;
let cleanup: () => Promise<void>;
let envSnapshot: NodeJS.ProcessEnv;

beforeEach(async () => {
  const repo = await createTestRepo();
  dir = repo.dir;
  cleanup = repo.cleanup;
  envSnapshot = { ...process.env };
  await init(dir);
  await gitInRepo(dir, ['add', '.']);
  await gitInRepo(dir, ['commit', '-m', 'init dubstack']);
});

afterEach(async () => {
  process.env = envSnapshot;
  await cleanup();
});

describe('create', () => {
  it('creates a branch from main and updates state', async () => {
    const result = await create('feat/first', dir);

    expect(result.branch).toBe('feat/first');
    expect(result.parent).toBe('main');
    expect(result.committed).toBeUndefined();
    expect(await getCurrentBranch(dir)).toBe('feat/first');

    const state = await readState(dir);
    expect(state.stacks).toHaveLength(1);
    expect(state.stacks[0].branches).toHaveLength(2);
    expect(state.stacks[0].branches[0]).toMatchObject({
      name: 'main',
      type: 'root',
    });
    expect(state.stacks[0].branches[1]).toMatchObject({
      name: 'feat/first',
      parent: 'main',
    });
  });

  it('creates a 3-deep chain in the same stack', async () => {
    await create('feat/first', dir);
    await create('feat/second', dir);

    const state = await readState(dir);
    expect(state.stacks).toHaveLength(1);
    expect(state.stacks[0].branches).toHaveLength(3);
    expect(state.stacks[0].branches[2]).toMatchObject({
      name: 'feat/second',
      parent: 'feat/first',
    });
  });

  it('throws when branch already exists in git', async () => {
    await gitInRepo(dir, ['checkout', '-b', 'existing']);
    await gitInRepo(dir, ['checkout', 'main']);

    await expect(create('existing', dir)).rejects.toThrow('already exists');

    const state = await readState(dir);
    expect(state.stacks).toHaveLength(0);
  });

  it('auto-initializes when not initialized', async () => {
    const repo2 = await createTestRepo();
    try {
      await gitInRepo(repo2.dir, ['commit', '--allow-empty', '-m', 'seed']);
      const result = await create('feat/x', repo2.dir);

      expect(result.branch).toBe('feat/x');
      const state = await readState(repo2.dir);
      expect(state.stacks).toHaveLength(1);
    } finally {
      await repo2.cleanup();
    }
  });

  it('saves an undo entry', async () => {
    await create('feat/first', dir);

    const entry = await readUndoEntry(dir);
    expect(entry.operation).toBe('create');
    expect(entry.previousBranch).toBe('main');
    expect(entry.createdBranches).toEqual(['feat/first']);
    expect(entry.previousState.stacks).toHaveLength(0);
  });

  it('sets parent_revision to parent tip SHA on creation', async () => {
    const parentTip = await getBranchTip('main', dir);
    await create('feat/first', dir);

    const state = await readState(dir);
    const child = state.stacks[0].branches.find((b) => b.name === 'feat/first');
    expect(child?.parent_revision).toBe(parentTip);
  });
});

describe('create with -m', () => {
  it('creates branch and commits staged changes', async () => {
    fs.writeFileSync(path.join(dir, 'feature.ts'), 'export const x = 1;\n');
    await gitInRepo(dir, ['add', 'feature.ts']);

    const result = await create('feat/api', dir, {
      message: 'feat: add API',
    });

    expect(result.branch).toBe('feat/api');
    expect(result.committed).toBe('feat: add API');
    expect(await getCurrentBranch(dir)).toBe('feat/api');

    const { stdout } = await gitInRepo(dir, ['log', '-1', '--format=%s']);
    expect(stdout.trim()).toBe('feat: add API');
  });

  it('throws when nothing is staged', async () => {
    await expect(
      create('feat/empty', dir, { message: 'feat: nothing' }),
    ).rejects.toThrow('No staged changes');
  });
});

describe('create with -a -m', () => {
  it('stages all files, creates branch, and commits', async () => {
    fs.writeFileSync(path.join(dir, 'new-file.ts'), 'export const y = 2;\n');

    const result = await create('feat/ui', dir, {
      message: 'feat: add UI',
      all: true,
    });

    expect(result.branch).toBe('feat/ui');
    expect(result.committed).toBe('feat: add UI');

    const { stdout } = await gitInRepo(dir, ['log', '-1', '--format=%s']);
    expect(stdout.trim()).toBe('feat: add UI');

    const { stdout: status } = await gitInRepo(dir, ['status', '--porcelain']);
    expect(status.trim()).toBe('');
  });

  it('throws when working tree is clean', async () => {
    await expect(
      create('feat/clean', dir, { message: 'feat: noop', all: true }),
    ).rejects.toThrow('No changes to commit');
  });
});

describe('create with -a but no -m', () => {
  it('throws requiring -m', async () => {
    await expect(create('feat/bad', dir, { all: true })).rejects.toThrow(
      "require '-m'",
    );
  });
});

describe('create with -u -m', () => {
  it('stages tracked updates, creates branch, and commits', async () => {
    const trackedFile = path.join(dir, 'tracked.txt');
    fs.writeFileSync(trackedFile, 'one\n');
    await gitInRepo(dir, ['add', 'tracked.txt']);
    await gitInRepo(dir, ['commit', '-m', 'test: add tracked file']);
    fs.writeFileSync(trackedFile, 'two\n');

    const result = await create('feat/update', dir, {
      message: 'feat: update tracked files',
      update: true,
    });

    expect(result.branch).toBe('feat/update');
    expect(result.committed).toBe('feat: update tracked files');
    const { stdout } = await gitInRepo(dir, ['log', '-1', '--format=%s']);
    expect(stdout.trim()).toBe('feat: update tracked files');
  });

  it('requires -m when --update is passed', async () => {
    await expect(
      create('feat/update-only', dir, { update: true }),
    ).rejects.toThrow("require '-m'");
  });
});

describe('create with --ai', () => {
  it('uses the repo default to enable AI when no flag is passed', async () => {
    await writeConfig(
      {
        aiAssistantEnabled: true,
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
    process.env.DUBSTACK_GEMINI_API_KEY = 'gem-key';
    fs.writeFileSync(
      path.join(dir, 'ai-default.ts'),
      'export const defaulted = true;\n',
    );
    await gitInRepo(dir, ['add', 'ai-default.ts']);

    const generateText = vi.fn().mockResolvedValue({
      text: '{"branch":"feat/default-ai","message":"feat: default ai mode"}',
    });
    const googleModel = vi.fn().mockReturnValue('google-model');
    const createGoogleGenerativeAI = vi.fn().mockReturnValue(googleModel);
    const createGateway = vi.fn();

    const result = await create(
      undefined as unknown as string,
      dir,
      {},
      {
        generateText,
        createGoogleGenerativeAI,
        createGateway,
      },
    );

    expect(result.branch).toBe('feat/default-ai');
    expect(result.committed).toBe('feat: default ai mode');
  });

  it('allows --no-ai to override an enabled repo default', async () => {
    await writeConfig(
      {
        aiAssistantEnabled: true,
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

    const generateText = vi.fn();
    const createGoogleGenerativeAI = vi.fn();
    const createGateway = vi.fn();

    await expect(
      create(
        undefined as unknown as string,
        dir,
        { noAi: true },
        {
          generateText,
          createGoogleGenerativeAI,
          createGateway,
        },
      ),
    ).rejects.toThrow('Branch name is required.');

    expect(generateText).not.toHaveBeenCalled();
  });

  it('allows --ai to override a disabled repo default', async () => {
    await writeConfig(
      {
        aiAssistantEnabled: true,
        ai: {
          defaults: {
            createMetadata: false,
            submitDescription: false,
            flow: false,
          },
        },
      },
      dir,
    );
    process.env.DUBSTACK_GEMINI_API_KEY = 'gem-key';
    fs.writeFileSync(
      path.join(dir, 'ai-forced.ts'),
      'export const forced = true;\n',
    );
    await gitInRepo(dir, ['add', 'ai-forced.ts']);

    const generateText = vi.fn().mockResolvedValue({
      text: '{"branch":"feat/forced-ai","message":"feat: forced ai mode"}',
    });
    const googleModel = vi.fn().mockReturnValue('google-model');
    const createGoogleGenerativeAI = vi.fn().mockReturnValue(googleModel);
    const createGateway = vi.fn();

    const result = await create(
      undefined as unknown as string,
      dir,
      { ai: true },
      {
        generateText,
        createGoogleGenerativeAI,
        createGateway,
      },
    );

    expect(result.branch).toBe('feat/forced-ai');
    expect(result.committed).toBe('feat: forced ai mode');
  });

  it('rejects combining --ai and --no-ai', async () => {
    await expect(
      create(undefined as unknown as string, dir, {
        ai: true,
        noAi: true,
      }),
    ).rejects.toThrow("'--ai' cannot be combined with '--no-ai'.");
  });

  it('creates branch and commit from AI output using staged changes', async () => {
    await writeConfig({ aiAssistantEnabled: true }, dir);
    process.env.DUBSTACK_GEMINI_API_KEY = 'gem-key';
    fs.writeFileSync(path.join(dir, 'ai-feature.ts'), 'export const ai = 1;\n');
    await gitInRepo(dir, ['add', 'ai-feature.ts']);

    const generateText = vi.fn().mockResolvedValue({
      text: '{"branch":"feat/ai-created-branch","message":"feat: add ai create mode"}',
    });
    const googleModel = vi.fn().mockReturnValue('google-model');
    const createGoogleGenerativeAI = vi.fn().mockReturnValue(googleModel);
    const createGateway = vi.fn();

    const result = await create(
      undefined as unknown as string,
      dir,
      { ai: true },
      {
        generateText,
        createGoogleGenerativeAI,
        createGateway,
      },
    );

    expect(result.branch).toBe('feat/ai-created-branch');
    expect(result.committed).toBe('feat: add ai create mode');

    const { stdout } = await gitInRepo(dir, ['log', '-1', '--format=%s']);
    expect(stdout.trim()).toBe('feat: add ai create mode');
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'google-model',
      }),
    );
  });

  it('preserves multiline AI commit messages when applying them', async () => {
    await writeConfig({ aiAssistantEnabled: true }, dir);
    process.env.DUBSTACK_GEMINI_API_KEY = 'gem-key';
    fs.writeFileSync(
      path.join(dir, '.gitmessage'),
      'feat(scope): summary\n\n## Testing\n- [ ] added\n',
    );
    await gitInRepo(dir, ['config', 'commit.template', '.gitmessage']);
    fs.writeFileSync(
      path.join(dir, 'ai-template.ts'),
      'export const aiTemplate = 1;\n',
    );
    await gitInRepo(dir, ['add', 'ai-template.ts']);

    const generateText = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        branch: 'feat/template-aware',
        message: 'feat: preserve template\n\n## Testing\n- [x] added coverage',
      }),
    });
    const googleModel = vi.fn().mockReturnValue('google-model');
    const createGoogleGenerativeAI = vi.fn().mockReturnValue(googleModel);
    const createGateway = vi.fn();

    const result = await create(
      undefined as unknown as string,
      dir,
      { ai: true },
      {
        generateText,
        createGoogleGenerativeAI,
        createGateway,
      },
    );

    expect(result.committed).toContain('## Testing');
    const { stdout } = await gitInRepo(dir, ['log', '-1', '--format=%B']);
    expect(stdout).toContain('feat: preserve template');
    expect(stdout).toContain('## Testing');
    expect(stdout).toContain('- [x] added coverage');
  });

  it('uses DUBSTACK_GEMINI_MODEL override when provided', async () => {
    await writeConfig({ aiAssistantEnabled: true }, dir);
    process.env.DUBSTACK_GEMINI_API_KEY = 'gem-key';
    process.env.DUBSTACK_GEMINI_MODEL = 'gemini-2.5-flash';
    fs.writeFileSync(
      path.join(dir, 'ai-model.ts'),
      'export const aiModel = 1;\n',
    );
    await gitInRepo(dir, ['add', 'ai-model.ts']);

    const generateText = vi.fn().mockResolvedValue({
      text: '{"branch":"feat/ai-model-override","message":"feat: model override"}',
    });
    const googleModel = vi.fn().mockReturnValue('google-model');
    const createGoogleGenerativeAI = vi.fn().mockReturnValue(googleModel);
    const createGateway = vi.fn();

    await create(
      undefined as unknown as string,
      dir,
      { ai: true },
      {
        generateText,
        createGoogleGenerativeAI,
        createGateway,
      },
    );

    expect(googleModel).toHaveBeenCalledWith('gemini-2.5-flash');
  });

  it('uses DUBSTACK_AI_GATEWAY_MODEL override when provided', async () => {
    await writeConfig({ aiAssistantEnabled: true }, dir);
    delete process.env.DUBSTACK_GEMINI_API_KEY;
    process.env.DUBSTACK_AI_GATEWAY_API_KEY = 'gateway-key';
    process.env.DUBSTACK_AI_GATEWAY_MODEL = 'google/gemini-2.5-flash';
    fs.writeFileSync(
      path.join(dir, 'ai-gateway.ts'),
      'export const viaGateway = 1;\n',
    );
    await gitInRepo(dir, ['add', 'ai-gateway.ts']);

    const generateText = vi.fn().mockResolvedValue({
      text: '{"branch":"feat/ai-gateway-model","message":"feat: gateway model override"}',
    });
    const createGoogleGenerativeAI = vi.fn();
    const gatewayModel = vi.fn().mockReturnValue('gateway-model');
    const createGateway = vi.fn().mockReturnValue(gatewayModel);

    await create(
      undefined as unknown as string,
      dir,
      { ai: true },
      {
        generateText,
        createGoogleGenerativeAI,
        createGateway,
      },
    );

    expect(createGoogleGenerativeAI).not.toHaveBeenCalled();
    expect(gatewayModel).toHaveBeenCalledWith('google/gemini-2.5-flash');
  });

  it('requires ai assistant to be enabled in config', async () => {
    process.env.DUBSTACK_GEMINI_API_KEY = 'gem-key';
    fs.writeFileSync(path.join(dir, 'ai-off.ts'), 'export const off = true;\n');
    await gitInRepo(dir, ['add', 'ai-off.ts']);

    const generateText = vi.fn();
    const googleModel = vi.fn().mockReturnValue('google-model');
    const createGoogleGenerativeAI = vi.fn().mockReturnValue(googleModel);
    const createGateway = vi.fn();

    await expect(
      create(
        undefined as unknown as string,
        dir,
        { ai: true },
        {
          generateText,
          createGoogleGenerativeAI,
          createGateway,
        },
      ),
    ).rejects.toThrow('AI assistant is disabled for this repo.');
  });

  it('redacts sensitive staged diff content before sending prompt to AI', async () => {
    await writeConfig({ aiAssistantEnabled: true }, dir);
    process.env.DUBSTACK_GEMINI_API_KEY = 'gem-key';

    fs.writeFileSync(
      path.join(dir, 'secrets.ts'),
      'export const token = "sk-supersecret123456";\nexport const key = "AIzaSecretToken1234567890";\n',
    );
    await gitInRepo(dir, ['add', 'secrets.ts']);

    const generateText = vi.fn().mockResolvedValue({
      text: '{"branch":"feat/redacted-prompt","message":"feat: redact ai prompt diff"}',
    });
    const googleModel = vi.fn().mockReturnValue('google-model');
    const createGoogleGenerativeAI = vi.fn().mockReturnValue(googleModel);
    const createGateway = vi.fn();

    await create(
      undefined as unknown as string,
      dir,
      { ai: true },
      {
        generateText,
        createGoogleGenerativeAI,
        createGateway,
      },
    );

    const call = vi.mocked(generateText).mock.calls[0]?.[0];
    expect(call).toBeDefined();
    const prompt = String(call?.prompt ?? '');
    expect(prompt).toContain('[REDACTED]');
    expect(prompt).not.toContain('sk-supersecret123456');
    expect(prompt).not.toContain('AIzaSecretToken1234567890');
  });
});
