import { describe, expect, it } from 'vitest';
import { _resetAiDepsForTests, loadAiDeps, peekAiDeps } from './ai-deps';

describe('loadAiDeps', () => {
  it('resolves all provider constructors lazily', async () => {
    _resetAiDepsForTests();
    expect(peekAiDeps()).toBeNull();
    const deps = await loadAiDeps();
    expect(typeof deps.generateText).toBe('function');
    expect(typeof deps.streamText).toBe('function');
    expect(typeof deps.stepCountIs).toBe('function');
    expect(typeof deps.createGoogleGenerativeAI).toBe('function');
    expect(typeof deps.createAnthropic).toBe('function');
    expect(typeof deps.createGateway).toBe('function');
    expect(typeof deps.createAmazonBedrock).toBe('function');
    expect(typeof deps.createOpenAI).toBe('function');
    expect(typeof deps.createOpenAICompatible).toBe('function');
    expect(typeof deps.fromIni).toBe('function');
    expect(typeof deps.fromNodeProviderChain).toBe('function');
  });

  it('returns the same instance on a second call (caches)', async () => {
    _resetAiDepsForTests();
    const a = await loadAiDeps();
    const b = await loadAiDeps();
    expect(a).toBe(b);
  });

  it('peekAiDeps reflects the cache state', async () => {
    _resetAiDepsForTests();
    expect(peekAiDeps()).toBeNull();
    await loadAiDeps();
    expect(peekAiDeps()).not.toBeNull();
  });
});
