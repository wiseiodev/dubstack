import { render } from '@inquirer/testing';
import { describe, expect, it } from 'vitest';
import { type BranchPickerChoice, branchPickerPrompt } from './branch-picker';

function makeChoices(): BranchPickerChoice[] {
  return [
    {
      value: 'main',
      label: 'main',
      searchKey: 'main',
      disabled: '(current)',
    },
    {
      value: 'feat/auth-login',
      label: 'feat/auth-login',
      searchKey: 'feat/auth-login',
    },
    {
      value: 'feat/auth-signup',
      label: 'feat/auth-signup',
      searchKey: 'feat/auth-signup',
    },
    { value: 'feat/billing', label: 'feat/billing', searchKey: 'feat/billing' },
  ];
}

describe('branchPickerPrompt', () => {
  it('returns checkout on Enter for the highlighted branch', async () => {
    const { answer, events } = await render(branchPickerPrompt, {
      message: 'pick',
      choices: makeChoices(),
      defaultBranch: 'feat/auth-login',
    });
    events.keypress({ name: 'return' });
    await expect(answer).resolves.toEqual({
      type: 'checkout',
      branch: 'feat/auth-login',
    });
  });

  it('filters by fuzzy search and returns the match', async () => {
    const { answer, events } = await render(branchPickerPrompt, {
      message: 'pick',
      choices: makeChoices(),
    });
    events.type('bill');
    events.keypress({ name: 'return' });
    await expect(answer).resolves.toEqual({
      type: 'checkout',
      branch: 'feat/billing',
    });
  });

  it('dispatches `p` as a pr action on the highlighted branch', async () => {
    const { answer, events } = await render(branchPickerPrompt, {
      message: 'pick',
      choices: makeChoices(),
      defaultBranch: 'feat/auth-signup',
    });
    events.keypress({ name: 'p' });
    await expect(answer).resolves.toEqual({
      type: 'pr',
      branch: 'feat/auth-signup',
    });
  });

  it('dispatches `d` as a diff action', async () => {
    const { answer, events } = await render(branchPickerPrompt, {
      message: 'pick',
      choices: makeChoices(),
      defaultBranch: 'feat/billing',
    });
    events.keypress({ name: 'd' });
    await expect(answer).resolves.toEqual({
      type: 'diff',
      branch: 'feat/billing',
    });
  });

  it('dispatches `c` as a copy action', async () => {
    const { answer, events } = await render(branchPickerPrompt, {
      message: 'pick',
      choices: makeChoices(),
      defaultBranch: 'feat/auth-login',
    });
    events.keypress({ name: 'c' });
    await expect(answer).resolves.toEqual({
      type: 'copy',
      branch: 'feat/auth-login',
    });
  });

  it('treats `p` typed into search input as text, not a shortcut', async () => {
    // Typing characters that would otherwise be shortcuts must filter the
    // list (e.g. `feat/auth-signup` contains `p`) instead of opening a PR.
    const { answer, events } = await render(branchPickerPrompt, {
      message: 'pick',
      choices: makeChoices(),
    });
    events.type('signup');
    events.keypress({ name: 'return' });
    await expect(answer).resolves.toEqual({
      type: 'checkout',
      branch: 'feat/auth-signup',
    });
  });

  it('returns cancel on Escape', async () => {
    const { answer, events } = await render(branchPickerPrompt, {
      message: 'pick',
      choices: makeChoices(),
    });
    events.keypress({ name: 'escape' });
    await expect(answer).resolves.toEqual({ type: 'cancel' });
  });

  it('renders the help line with key bindings', async () => {
    const { answer, events, getScreen } = await render(branchPickerPrompt, {
      message: 'pick',
      choices: makeChoices(),
    });
    const screen = getScreen();
    expect(screen).toContain('navigate');
    expect(screen).toContain('checkout');
    expect(screen).toContain('open PR');
    expect(screen).toContain('diff');
    expect(screen).toContain('copy');
    expect(screen).toContain('cancel');
    events.keypress({ name: 'escape' });
    await answer;
  });

  it('shows the footer when one is provided', async () => {
    const { answer, events, getScreen } = await render(branchPickerPrompt, {
      message: 'pick',
      choices: makeChoices(),
      footer: 'ℹ Showing 5+ branches',
    });
    expect(getScreen()).toContain('Showing 5+ branches');
    events.keypress({ name: 'escape' });
    await answer;
  });

  it('renders "No branches match." when the filter rules out every row', async () => {
    const { answer, events, getScreen } = await render(branchPickerPrompt, {
      message: 'pick',
      choices: makeChoices(),
    });
    events.type('zzzzz');
    expect(getScreen()).toContain('No branches match.');
    events.keypress({ name: 'escape' });
    await answer;
  });

  it('does not hang when arrow keys are pressed and only the disabled row matches', async () => {
    // Regression: with only the (current) row visible, the navigation loop
    // had no selectable target and could spin forever. Guard returns early.
    const { answer, events } = await render(branchPickerPrompt, {
      message: 'pick',
      choices: makeChoices(),
    });
    events.type('main'); // only matches the disabled `main` row
    events.keypress({ name: 'down' });
    events.keypress({ name: 'up' });
    events.keypress({ name: 'return' }); // Enter on disabled row → no-op
    events.keypress({ name: 'escape' });
    await expect(answer).resolves.toEqual({ type: 'cancel' });
  });
});
