import { describe, expect, it } from 'vitest';
import { _testing } from './reorder';

describe('reorder _testing.todoIndexToDisplayIndex', () => {
  it('maps oldest-first todo indices to newest-first display indices', () => {
    // 3 commits, newest-first display = [C, B, A]; oldest-first todo = [A, B, C]
    expect(_testing.todoIndexToDisplayIndex(0, 3)).toBe(2); // A → bottom of display
    expect(_testing.todoIndexToDisplayIndex(1, 3)).toBe(1); // B → middle
    expect(_testing.todoIndexToDisplayIndex(2, 3)).toBe(0); // C → top of display
  });
});

describe('reorder _testing.buildActionPromptInput', () => {
  it('assigns todoIndex so the display-bottom entry maps to index 0', () => {
    const result = _testing.buildActionPromptInput([
      { commit: { sha: 'c', shortSha: 'c', subject: 'C' }, action: 'pick' },
      { commit: { sha: 'b', shortSha: 'b', subject: 'B' }, action: 'pick' },
      { commit: { sha: 'a', shortSha: 'a', subject: 'A' }, action: 'pick' },
    ]);
    // Display is [C, B, A] (newest first). On disk: [A, B, C].
    expect(result.entries.map((e) => e.todoIndex)).toEqual([2, 1, 0]);
  });
});
