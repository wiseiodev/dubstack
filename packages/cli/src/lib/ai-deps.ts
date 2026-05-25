/**
 * Lazy loader for the AI SDK constructors used across commands.
 *
 * The AI provider modules (`@ai-sdk/anthropic`, `@ai-sdk/google`, `ai`,
 * `@aws-sdk/credential-providers`, …) each cost a measurable amount of
 * cold-start to import — combined they add ~50ms even when the user runs an
 * AI-free command like `dub log`. We defer the import to first use here so
 * the read-only fast path stays cheap.
 *
 * Returned dependencies are cached for the lifetime of the process. Tests
 * that need a different shape pass their own object instead of calling this
 * helper.
 */

import type { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import type { createAnthropic } from '@ai-sdk/anthropic';
import type { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { createOpenAI } from '@ai-sdk/openai';
import type { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type {
  fromIni,
  fromNodeProviderChain,
} from '@aws-sdk/credential-providers';
import type { createGateway, generateText, stepCountIs, streamText } from 'ai';

export interface AiSdkDeps {
  generateText: typeof generateText;
  streamText: typeof streamText;
  stepCountIs: typeof stepCountIs;
  createGoogleGenerativeAI: typeof createGoogleGenerativeAI;
  createAnthropic: typeof createAnthropic;
  createGateway: typeof createGateway;
  createAmazonBedrock: typeof createAmazonBedrock;
  createOpenAI: typeof createOpenAI;
  createOpenAICompatible: typeof createOpenAICompatible;
  fromIni: typeof fromIni;
  fromNodeProviderChain: typeof fromNodeProviderChain;
}

let cached: AiSdkDeps | null = null;
let cachedPromise: Promise<AiSdkDeps> | null = null;

export async function loadAiDeps(): Promise<AiSdkDeps> {
  if (cached) return cached;
  if (cachedPromise) return cachedPromise;
  cachedPromise = (async () => {
    const [bedrock, anthropic, google, openai, openaiCompatible, awsCreds, ai] =
      await Promise.all([
        import('@ai-sdk/amazon-bedrock'),
        import('@ai-sdk/anthropic'),
        import('@ai-sdk/google'),
        import('@ai-sdk/openai'),
        import('@ai-sdk/openai-compatible'),
        import('@aws-sdk/credential-providers'),
        import('ai'),
      ]);
    cached = {
      generateText: ai.generateText,
      streamText: ai.streamText,
      stepCountIs: ai.stepCountIs,
      createGoogleGenerativeAI: google.createGoogleGenerativeAI,
      createAnthropic: anthropic.createAnthropic,
      createGateway: ai.createGateway,
      createAmazonBedrock: bedrock.createAmazonBedrock,
      createOpenAI: openai.createOpenAI,
      createOpenAICompatible: openaiCompatible.createOpenAICompatible,
      fromIni: awsCreds.fromIni,
      fromNodeProviderChain: awsCreds.fromNodeProviderChain,
    };
    return cached;
  })();
  return cachedPromise;
}

/**
 * Synchronous accessor for the cached deps. Returns `null` until the first
 * `loadAiDeps()` resolves. Useful for tests asserting that no AI module is
 * loaded yet on a cold path.
 */
export function peekAiDeps(): AiSdkDeps | null {
  return cached;
}

/** Reset internal caches (test-only). */
export function _resetAiDepsForTests(): void {
  cached = null;
  cachedPromise = null;
}
