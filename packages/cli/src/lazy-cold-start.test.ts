import { describe, expect, it } from 'vitest';

describe('cold-start lazy-loading', () => {
  it('does not import @ai-sdk/* modules until AI is actually used', async () => {
    // Importing the CLI entry point loads every command module via static
    // imports. With the lazy refactor those modules use `import type` for the
    // AI SDK, so the underlying provider packages should not have been
    // evaluated yet — `peekAiDeps()` should still report `null`.
    await import('./index');
    const { peekAiDeps, _resetAiDepsForTests } = await import('./lib/ai-deps');
    _resetAiDepsForTests();
    expect(peekAiDeps()).toBeNull();
  });
});
