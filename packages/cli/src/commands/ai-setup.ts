import input from '@inquirer/input';
import password from '@inquirer/password';
import select from '@inquirer/select';
import {
  type ConfigureAiEnvOptions,
  type ConfigureAiEnvResult,
  configureAiEnv,
} from './ai-env';
import {
  type AiModelProvider,
  configAiModel,
  configAiProvider,
} from './config';

const CUSTOM_MODEL = '__custom__';

type ModelScope = 'global' | 'repo';

export interface AiSetupResult {
  provider: AiModelProvider;
  model: string;
  modelScope: ModelScope;
  updatedEnv: string[];
  profilePath?: string;
  activationCommand?: string;
}

interface AiSetupDeps {
  selectProvider: () => Promise<AiModelProvider>;
  selectModel: (provider: AiModelProvider) => Promise<string>;
  inputCustomModel: (provider: AiModelProvider) => Promise<string>;
  selectModelScope: () => Promise<ModelScope>;
  inputGeminiKey: () => Promise<string | undefined>;
  inputAnthropicKey: () => Promise<string | undefined>;
  inputGatewayKey: () => Promise<string | undefined>;
  inputOpenAiKey: () => Promise<string | undefined>;
  inputBedrockProfile: () => Promise<string | undefined>;
  inputBedrockRegion: () => Promise<string | undefined>;
  configureAiEnv: (
    options: ConfigureAiEnvOptions,
  ) => Promise<ConfigureAiEnvResult>;
  configAiProvider: typeof configAiProvider;
  configAiModel: typeof configAiModel;
}

const DEFAULT_DEPS: AiSetupDeps = {
  selectProvider: async () =>
    select({
      message: 'Choose the AI provider for this repository',
      choices: [
        { name: 'Gemini', value: 'gemini' },
        { name: 'Anthropic Claude', value: 'anthropic' },
        { name: 'AI Gateway', value: 'gateway' },
        { name: 'Amazon Bedrock', value: 'bedrock' },
        { name: 'OpenAI', value: 'openai' },
      ],
    }),
  selectModel: async (provider) =>
    select({
      message: 'Choose a model',
      choices: getModelChoices(provider).map((choice) => ({
        name: choice.label,
        value: choice.value,
      })),
    }),
  inputCustomModel: async () =>
    input({
      message: 'Enter the full model ID',
      validate: (value) =>
        value.trim().length > 0 ? true : 'Model cannot be empty.',
    }),
  selectModelScope: async () =>
    select({
      message: 'Where should this model be stored?',
      choices: [
        {
          name: 'Global default (shell profile export)',
          value: 'global',
        },
        {
          name: 'Current repo override (.git/dubstack/config.json)',
          value: 'repo',
        },
      ],
    }),
  inputGeminiKey: async () => optionalSecret('Enter DUBSTACK_GEMINI_API_KEY'),
  inputAnthropicKey: async () =>
    optionalSecret('Enter DUBSTACK_ANTHROPIC_API_KEY'),
  inputGatewayKey: async () =>
    optionalSecret('Enter DUBSTACK_AI_GATEWAY_API_KEY'),
  inputOpenAiKey: async () => optionalSecret('Enter DUBSTACK_OPENAI_API_KEY'),
  inputBedrockProfile: async () =>
    optionalText('Enter DUBSTACK_BEDROCK_AWS_PROFILE'),
  inputBedrockRegion: async () =>
    optionalText('Enter DUBSTACK_BEDROCK_AWS_REGION'),
  configureAiEnv,
  configAiProvider,
  configAiModel,
};

export async function aiSetup(
  cwd: string,
  deps: Partial<AiSetupDeps> = {},
): Promise<AiSetupResult> {
  const resolvedDeps: AiSetupDeps = {
    ...DEFAULT_DEPS,
    ...deps,
  };

  const provider = await resolvedDeps.selectProvider();
  const selectedModel = await resolvedDeps.selectModel(provider);
  const model =
    selectedModel === CUSTOM_MODEL
      ? (await resolvedDeps.inputCustomModel(provider)).trim()
      : selectedModel;
  const modelScope = await resolvedDeps.selectModelScope();

  const envOptions = await buildEnvOptions(
    provider,
    model,
    modelScope,
    resolvedDeps,
  );
  const envResult = hasEnvUpdates(envOptions)
    ? await resolvedDeps.configureAiEnv(envOptions)
    : null;

  await resolvedDeps.configAiProvider(cwd, provider);
  if (modelScope === 'repo') {
    await resolvedDeps.configAiModel(cwd, provider, model);
  } else {
    await resolvedDeps.configAiModel(cwd, provider, undefined, {
      clear: true,
    });
  }

  return {
    provider,
    model,
    modelScope,
    updatedEnv: envResult?.updated ?? [],
    profilePath: envResult?.profilePath,
    activationCommand: envResult?.activationCommand,
  };
}

function hasEnvUpdates(options: ConfigureAiEnvOptions): boolean {
  return Object.values(options).some((value) => value !== undefined);
}

async function buildEnvOptions(
  provider: AiModelProvider,
  model: string,
  modelScope: ModelScope,
  deps: AiSetupDeps,
): Promise<ConfigureAiEnvOptions> {
  if (provider === 'gemini') {
    const geminiKey = await deps.inputGeminiKey();
    return {
      geminiKey,
      geminiModel: modelScope === 'global' ? model : undefined,
    };
  }

  if (provider === 'anthropic') {
    const anthropicKey = await deps.inputAnthropicKey();
    return {
      anthropicKey,
      anthropicModel: modelScope === 'global' ? model : undefined,
    };
  }

  if (provider === 'gateway') {
    const gatewayKey = await deps.inputGatewayKey();
    return {
      gatewayKey,
      gatewayModel: modelScope === 'global' ? model : undefined,
    };
  }

  if (provider === 'openai') {
    const openaiKey = await deps.inputOpenAiKey();
    return {
      openaiKey,
      openaiModel: modelScope === 'global' ? model : undefined,
    };
  }

  return {
    bedrockProfile: await deps.inputBedrockProfile(),
    bedrockRegion: await deps.inputBedrockRegion(),
    bedrockModel: modelScope === 'global' ? model : undefined,
  };
}

async function optionalText(message: string): Promise<string | undefined> {
  const value = await input({
    message: `${message} (leave blank to keep current value)`,
  });
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function optionalSecret(message: string): Promise<string | undefined> {
  const value = await password({
    message: `${message} (leave blank to keep current value)`,
    mask: '*',
  });
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function getModelChoices(provider: AiModelProvider): Array<{
  label: string;
  value: string;
}> {
  if (provider === 'gemini') {
    return [
      { label: 'Gemini 3 Flash Preview', value: 'gemini-3-flash-preview' },
      { label: 'Gemini 2.5 Pro Preview', value: 'gemini-2.5-pro-preview' },
      { label: 'Custom model', value: CUSTOM_MODEL },
    ];
  }

  if (provider === 'gateway') {
    return [
      { label: 'Google Gemini 3 Flash', value: 'google/gemini-3-flash' },
      { label: 'Google Gemini 2.5 Pro', value: 'google/gemini-2.5-pro' },
      { label: 'Custom model', value: CUSTOM_MODEL },
    ];
  }

  if (provider === 'anthropic') {
    return [
      {
        label: 'Claude Sonnet 4',
        value: 'claude-sonnet-4-20250514',
      },
      {
        label: 'Claude Opus 4',
        value: 'claude-opus-4-20250514',
      },
      { label: 'Custom model', value: CUSTOM_MODEL },
    ];
  }

  if (provider === 'openai') {
    return [
      { label: 'GPT-5.5', value: 'gpt-5.5' },
      { label: 'GPT-5.4 Mini', value: 'gpt-5.4-mini' },
      { label: 'Custom model', value: CUSTOM_MODEL },
    ];
  }

  return [
    {
      label: 'Claude Sonnet 4.6 (Bedrock)',
      value: 'us.anthropic.claude-sonnet-4-6',
    },
    {
      label: 'Claude Haiku 4.5 (Bedrock)',
      value: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    },
    {
      label: 'Claude Opus 4.6 (Bedrock)',
      value: 'us.anthropic.claude-opus-4-6-v1',
    },
    { label: 'Custom model', value: CUSTOM_MODEL },
  ];
}
