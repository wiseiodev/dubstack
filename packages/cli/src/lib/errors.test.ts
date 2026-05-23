import { describe, expect, it } from 'vitest';
import { DubError, formatDubError } from './errors';

describe('DubError', () => {
  it('defaults recovery to an empty array when none is supplied', () => {
    const error = new DubError('something went wrong');

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('something went wrong');
    expect(error.recovery).toEqual([]);
    expect(error.name).toBe('DubError');
  });

  it('exposes the supplied recovery hints', () => {
    const error = new DubError("Branch 'feat/x' already exists.", [
      "Run 'dub checkout feat/x' to switch to it.",
      'Pick a different branch name and retry.',
    ]);

    expect(error.recovery).toEqual([
      "Run 'dub checkout feat/x' to switch to it.",
      'Pick a different branch name and retry.',
    ]);
  });
});

describe('formatDubError', () => {
  it('returns the bare message when recovery is empty', () => {
    expect(formatDubError(new DubError('boom'))).toBe('boom');
  });

  it('renders a numbered recovery block under the message', () => {
    const error = new DubError(
      "Sync paused: conflict while restacking 'feat/auth-ui'.",
      [
        'Resolve conflicts and stage the resolved files.',
        "Run 'dub continue --ai' to let DubStack try the resolution.",
        "Run 'dub continue' after resolving manually.",
        "Run 'dub abort' to roll back to the pre-sync state.",
      ],
    );

    expect(formatDubError(error)).toBe(
      [
        "Sync paused: conflict while restacking 'feat/auth-ui'.",
        '',
        'What you can do:',
        '  1. Resolve conflicts and stage the resolved files.',
        "  2. Run 'dub continue --ai' to let DubStack try the resolution.",
        "  3. Run 'dub continue' after resolving manually.",
        "  4. Run 'dub abort' to roll back to the pre-sync state.",
      ].join('\n'),
    );
  });

  it('preserves multi-line messages before the recovery block', () => {
    const error = new DubError('Line one\nLine two', ['Step one.']);

    expect(formatDubError(error)).toBe(
      ['Line one', 'Line two', '', 'What you can do:', '  1. Step one.'].join(
        '\n',
      ),
    );
  });
});
