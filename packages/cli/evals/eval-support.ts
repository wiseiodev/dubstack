import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createGateway, generateText, type LanguageModel } from 'ai';
import { createScorer } from 'evalite';
import {
  type PrDescriptionOutput,
  parseEvalJudgeResponse,
} from '../src/lib/ai-eval-scorers';
import type { AiMetadataDependencies } from '../src/lib/ai-metadata';
import type { DubConfig } from '../src/lib/config';

const evalsDir = dirname(fileURLToPath(import.meta.url));

export function readFixture<T>(name: string): T {
  const fixturePath = join(evalsDir, 'fixtures', name);
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as T;
}

export function createProviderConfig(): DubConfig['ai']['provider'] {
  return {
    selected: 'auto',
    models: {
      gemini: null,
      anthropic: null,
      gateway: null,
      bedrock: null,
      openai: null,
    },
  };
}

export function createEvalDependencies(): AiMetadataDependencies {
  return {
    generateText,
    createGoogleGenerativeAI,
    createAnthropic,
    createGateway,
    createOpenAI,
  };
}

export function resolveEvalJudgeModel(): LanguageModel {
  const geminiApiKey = process.env.DUBSTACK_GEMINI_API_KEY?.trim();
  if (geminiApiKey) {
    const modelId =
      process.env.DUBSTACK_GEMINI_MODEL?.trim() || 'gemini-3-flash-preview';
    const google = createGoogleGenerativeAI({ apiKey: geminiApiKey });
    return google(modelId);
  }

  const anthropicApiKey = process.env.DUBSTACK_ANTHROPIC_API_KEY?.trim();
  if (anthropicApiKey) {
    const modelId =
      process.env.DUBSTACK_ANTHROPIC_MODEL?.trim() ||
      'claude-sonnet-4-20250514';
    const anthropic = createAnthropic({ apiKey: anthropicApiKey });
    return anthropic(modelId);
  }

  const gatewayApiKey = process.env.DUBSTACK_AI_GATEWAY_API_KEY?.trim();
  if (gatewayApiKey) {
    const modelId =
      process.env.DUBSTACK_AI_GATEWAY_MODEL?.trim() || 'google/gemini-3-flash';
    const gateway = createGateway({ apiKey: gatewayApiKey });
    return gateway(modelId);
  }

  const openAiApiKey = process.env.DUBSTACK_OPENAI_API_KEY?.trim();
  if (openAiApiKey) {
    const modelId = process.env.DUBSTACK_OPENAI_MODEL?.trim() || 'gpt-5.5';
    const openai = createOpenAI({ apiKey: openAiApiKey });
    return openai(modelId);
  }

  throw new Error(
    'Evalite requires DUBSTACK_GEMINI_API_KEY, DUBSTACK_ANTHROPIC_API_KEY, DUBSTACK_AI_GATEWAY_API_KEY, or DUBSTACK_OPENAI_API_KEY.',
  );
}

export function createFaithfulnessJudgeScorer<
  TInput extends { name: string },
  TOutput,
  TExpected extends { summary?: string },
>(details: {
  name: string;
  outputToText: (output: TOutput) => string;
  inputToText: (input: TInput) => string;
}) {
  return createScorer<TInput, TOutput, TExpected>({
    name: details.name,
    description:
      'AI judge for reviewer usefulness, diff fidelity, and invented-claim avoidance.',
    scorer: async ({ input, output, expected }) => {
      const response = await generateText({
        model: resolveEvalJudgeModel(),
        system:
          'You are grading DubStack AI workflow output. Return strict JSON only.',
        prompt: [
          'Score from 0 to 100.',
          'Rubric:',
          '- Faithful to the supplied fixture and expected intent',
          '- Useful to a reviewer or operator',
          '- Preserves explicit constraints and avoids invented changes',
          '- Penalize missing required details, duplicated files, or dropped intent',
          'Return JSON exactly like {"score":87,"rationale":"..."}',
          '',
          `Case: ${input.name}`,
          `Expected intent: ${expected?.summary ?? ''}`,
          '',
          'INPUT_START',
          details.inputToText(input),
          'INPUT_END',
          '',
          'OUTPUT_START',
          details.outputToText(output),
          'OUTPUT_END',
        ].join('\n'),
      });

      const parsed = parseEvalJudgeResponse(response.text);
      return {
        score: parsed.score / 100,
        metadata: { rationale: parsed.rationale },
      };
    },
  });
}

export function formatPrOutput(output: PrDescriptionOutput): string {
  return output.prDescription;
}
