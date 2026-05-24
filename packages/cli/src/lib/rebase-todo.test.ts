import { describe, expect, it } from 'vitest';
import { DubError } from './errors';
import { buildRebaseTodo, isNoopReorder } from './rebase-todo';

describe('buildRebaseTodo', () => {
  it('renders pick/drop lines in the order given, oldest first', () => {
    const todo = buildRebaseTodo([
      { sha: 'aaaaaaa', action: 'pick', subject: 'first commit' },
      { sha: 'bbbbbbb', action: 'drop', subject: 'drop me' },
      { sha: 'ccccccc', action: 'pick', subject: 'last commit' },
    ]);
    expect(todo).toBe(
      'pick aaaaaaa first commit\ndrop bbbbbbb drop me\npick ccccccc last commit\n',
    );
  });

  it('omits the trailing subject space when subject is missing or whitespace', () => {
    const todo = buildRebaseTodo([
      { sha: 'aaaaaaa', action: 'pick' },
      { sha: 'bbbbbbb', action: 'pick', subject: '   ' },
    ]);
    expect(todo).toBe('pick aaaaaaa\npick bbbbbbb\n');
  });

  it('throws DubError with recovery hint when no entries are provided', () => {
    expect(() => buildRebaseTodo([])).toThrow(DubError);
    expect(() => buildRebaseTodo([])).toThrow(/empty rebase todo/);
  });

  it('always ends with a trailing newline', () => {
    const todo = buildRebaseTodo([{ sha: 'aaaaaaa', action: 'pick' }]);
    expect(todo.endsWith('\n')).toBe(true);
  });
});

describe('isNoopReorder', () => {
  const original = ['aaaaaaa', 'bbbbbbb', 'ccccccc'];

  it('returns true when entries match original order and all are picks', () => {
    expect(
      isNoopReorder(original, [
        { sha: 'aaaaaaa', action: 'pick' },
        { sha: 'bbbbbbb', action: 'pick' },
        { sha: 'ccccccc', action: 'pick' },
      ]),
    ).toBe(true);
  });

  it('returns false when any entry is dropped', () => {
    expect(
      isNoopReorder(original, [
        { sha: 'aaaaaaa', action: 'pick' },
        { sha: 'bbbbbbb', action: 'drop' },
        { sha: 'ccccccc', action: 'pick' },
      ]),
    ).toBe(false);
  });

  it('returns false when entries are reordered', () => {
    expect(
      isNoopReorder(original, [
        { sha: 'ccccccc', action: 'pick' },
        { sha: 'bbbbbbb', action: 'pick' },
        { sha: 'aaaaaaa', action: 'pick' },
      ]),
    ).toBe(false);
  });

  it('returns false when lengths differ', () => {
    expect(
      isNoopReorder(original, [
        { sha: 'aaaaaaa', action: 'pick' },
        { sha: 'bbbbbbb', action: 'pick' },
      ]),
    ).toBe(false);
  });
});
