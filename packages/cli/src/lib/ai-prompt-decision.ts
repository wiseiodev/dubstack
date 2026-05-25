import { stdin as input, stdout as output } from 'node:process';
import * as readline from 'node:readline/promises';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { fromIni, fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { createGateway, streamText } from 'ai';
import chalk from 'chalk';
import {
  buildAiProviderOptions,
  type ResolveAiProviderDeps,
  type ResolvedAiProvider,
  resolveAiProvider,
} from './ai-provider';
import { type DubConfig, readConfig } from './config';
import { DubError } from './errors';

export type AiPromptConfidence = 'high' | 'medium' | 'low';

export interface AiPromptChoice<T extends string> {
  label: string;
  value: T;
}

export interface AiPromptRecommendation<T extends string> {
  choice: T;
  confidence: AiPromptConfidence;
  reasoning: string;
}

export interface AiPromptDecisionDeps extends ResolveAiProviderDeps {
  readConfig: typeof readConfig;
  streamText: typeof streamText;
  confirmRecommendation: (message: string) => Promise<boolean>;
  writePreview: (text: string) => void;
}

const DEFAULT_DEPS: AiPromptDecisionDeps = {
  readConfig,
  streamText,
  createGoogleGenerativeAI,
  createAnthropic,
  createGateway,
  createAmazonBedrock,
  createOpenAI,
  createOpenAICompatible,
  fromIni,
  fromNodeProviderChain,
  confirmRecommendation,
  writePreview: (text: string) => process.stdout.write(text),
};

export function aiPromptOptionsEnabled(config: DubConfig): boolean {
  return config.aiAssistantEnabled && config.ai.prompts.mode !== 'off';
}

export async function isAiPromptOptionEnabled(
  cwd: string,
  deps: Pick<AiPromptDecisionDeps, 'readConfig'> = DEFAULT_DEPS,
): Promise<boolean> {
  const config = await deps.readConfig(cwd);
  return aiPromptOptionsEnabled(config);
}

export async function resolveAiPromptDecision<T extends string>(input: {
  cwd: string;
  scenario: string;
  subject: string;
  context: string;
  choices: Array<AiPromptChoice<T>>;
  fallbackPrompt: () => Promise<T>;
  deps?: AiPromptDecisionDeps;
}): Promise<T> {
  const deps = input.deps ?? DEFAULT_DEPS;
  const config = await deps.readConfig(input.cwd);
  if (!aiPromptOptionsEnabled(config)) {
    return input.fallbackPrompt();
  }

  const resolved = resolveAiProvider({
    deps,
    providerConfig: config.ai.provider,
  });
  const recommendation = await streamRecommendation(
    {
      scenario: input.scenario,
      subject: input.subject,
      context: input.context,
      choices: input.choices,
    },
    resolved,
    deps,
  );

  const selected = input.choices.find(
    (choice) => choice.value === recommendation.choice,
  );
  if (!selected) {
    console.log(
      chalk.yellow(
        `AI returned unsupported choice '${recommendation.choice}'. Falling back to manual choices.`,
      ),
    );
    return input.fallbackPrompt();
  }

  console.log(
    chalk.blue(
      `AI recommends: ${selected.label} (${recommendation.confidence} confidence)`,
    ),
  );
  if (recommendation.reasoning.trim()) {
    console.log(chalk.dim(recommendation.reasoning.trim()));
  }

  if (recommendation.confidence === 'low') {
    console.log(
      chalk.yellow('AI confidence is low. Falling back to manual choices.'),
    );
    return input.fallbackPrompt();
  }

  if (
    recommendation.confidence === 'high' &&
    config.ai.prompts.autoAccept === 'high'
  ) {
    return recommendation.choice;
  }

  const confirmed = await deps.confirmRecommendation(
    `Apply AI recommendation "${selected.label}"?`,
  );
  if (confirmed) return recommendation.choice;

  return input.fallbackPrompt();
}

function buildSystemPrompt<T extends string>(
  choices: Array<AiPromptChoice<T>>,
): string {
  return [
    'You are helping choose one DubStack interactive prompt option.',
    'Pick exactly one of the provided option values.',
    'Use high confidence only when the available context clearly supports the action.',
    'Use low confidence when context is missing, risky, or ambiguous.',
    'Return ONLY JSON with keys: choice, confidence, reasoning.',
    `Allowed choices: ${choices.map((choice) => choice.value).join(', ')}.`,
  ].join(' ');
}

function buildUserPrompt<T extends string>(input: {
  scenario: string;
  subject: string;
  context: string;
  choices: Array<AiPromptChoice<T>>;
}): string {
  return [
    `Scenario: ${input.scenario}`,
    `Subject: ${input.subject}`,
    '',
    'Choices:',
    ...input.choices.map((choice) => `- ${choice.value}: ${choice.label}`),
    '',
    'Context:',
    input.context.trim() || '(no additional context available)',
  ].join('\n');
}

async function streamRecommendation<T extends string>(
  input: {
    scenario: string;
    subject: string;
    context: string;
    choices: Array<AiPromptChoice<T>>;
  },
  resolved: ResolvedAiProvider,
  deps: AiPromptDecisionDeps,
): Promise<AiPromptRecommendation<T>> {
  console.log(
    chalk.dim(
      `AI reasoning preview (${resolved.provider}:${resolved.modelId})`,
    ),
  );

  const result = deps.streamText({
    model: resolved.model,
    system: buildSystemPrompt(input.choices),
    prompt: buildUserPrompt(input),
    providerOptions: buildAiProviderOptions(resolved, {
      withWebBrowsing: false,
    }) as never,
  });

  let fullText = '';
  for await (const part of result.fullStream) {
    if (part.type === 'text-delta') {
      const text = part.text ?? '';
      fullText += text;
      deps.writePreview(chalk.dim(text));
    } else if (part.type === 'error') {
      throw part.error instanceof Error
        ? part.error
        : new DubError('AI prompt decision failed unexpectedly.', [
            'Pick one of the manual choices instead.',
            "Run 'dub config ai-prompts off' to hide AI prompt choices.",
          ]);
    }
  }
  deps.writePreview('\n');

  return parseRecommendation(fullText);
}

export function parseRecommendation<T extends string>(
  text: string,
): AiPromptRecommendation<T> {
  let jsonStr = text.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  const objectStart = jsonStr.indexOf('{');
  const objectEnd = jsonStr.lastIndexOf('}');
  if (objectStart !== -1 && objectEnd !== -1 && objectEnd > objectStart) {
    jsonStr = jsonStr.slice(objectStart, objectEnd + 1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new DubError('Could not parse AI prompt recommendation.', [
      'Pick one of the manual choices instead.',
      "Run 'dub config ai-prompts off' to hide AI prompt choices.",
    ]);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new DubError('AI returned an invalid prompt recommendation.', [
      'Pick one of the manual choices instead.',
    ]);
  }

  const item = parsed as Record<string, unknown>;
  return {
    choice: String(item.choice ?? '') as T,
    confidence: normalizeConfidence(item.confidence),
    reasoning: String(item.reasoning ?? ''),
  };
}

function normalizeConfidence(value: unknown): AiPromptConfidence {
  if (value === 'high' || value === 'medium' || value === 'low') return value;
  return 'low';
}

async function confirmRecommendation(message: string): Promise<boolean> {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(`${message} [Y/n] `);
    const normalized = answer.trim().toLowerCase();
    return normalized === '' || normalized === 'y' || normalized === 'yes';
  } finally {
    rl.close();
  }
}
