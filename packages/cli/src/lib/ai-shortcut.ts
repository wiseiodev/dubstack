import * as readline from 'node:readline/promises';
import { DubError } from './errors';

export type InvocationMode =
  | 'explicit-ai'
  | 'shortcut-fallback'
  | 'shortcut-forced';

export type ShortcutChoice = 'run-command' | 'ask-ai' | 'cancel';

export interface ShortcutMetadata {
  invocationMode?: InvocationMode;
  typoGuardTriggered?: boolean;
}

export interface PreprocessCliArgsResult {
  finalArgs: string[];
  metadata: ShortcutMetadata;
}

export interface CommandDescriptor {
  name: () => string;
  aliases: () => string[];
}

export function collectKnownTopLevelCommands(
  commands: readonly CommandDescriptor[],
): Set<string> {
  const known = new Set<string>();
  for (const command of commands) {
    known.add(command.name());
    for (const alias of command.aliases()) {
      known.add(alias);
    }
  }
  return known;
}

export async function preprocessCliArgs(
  rawArgs: string[],
  knownCommands: Set<string>,
  isInteractiveTty: boolean,
  chooseTypoResolution: (
    input: string,
    suggestion: string,
  ) => Promise<ShortcutChoice>,
): Promise<PreprocessCliArgsResult> {
  if (rawArgs.length === 0) {
    return {
      finalArgs: rawArgs,
      metadata: {},
    };
  }

  const first = rawArgs[0];
  if (first === '--ai') {
    const promptArgs = rawArgs.slice(1);
    if (promptArgs.length === 0) {
      throw new DubError('Prompt cannot be empty when using --ai.', [
        'Pass a non-empty prompt (e.g. \'dub --ai "summarize my stack"\').',
      ]);
    }
    return {
      finalArgs: ['ai', 'ask', ...promptArgs],
      metadata: {
        invocationMode: 'shortcut-forced',
        typoGuardTriggered: false,
      },
    };
  }

  if (first.startsWith('-') || knownCommands.has(first)) {
    return {
      finalArgs: rawArgs,
      metadata: {},
    };
  }

  const suggestion = suggestLikelyCommand(first, knownCommands);
  if (suggestion) {
    if (!isInteractiveTty) {
      throw new DubError(`Unknown command '${first}'.`, [
        `Did you mean 'dub ${suggestion}'?`,
        "Rerun with '--ai' (e.g. 'dub --ai \"<prompt>\"') to treat this as an AI prompt.",
      ]);
    }

    const choice = await chooseTypoResolution(first, suggestion);
    if (choice === 'run-command') {
      return {
        finalArgs: [suggestion, ...rawArgs.slice(1)],
        metadata: {
          typoGuardTriggered: true,
        },
      };
    }
    if (choice === 'cancel') {
      throw new DubError('Cancelled.', []);
    }
    return {
      finalArgs: ['ai', 'ask', ...rawArgs],
      metadata: {
        invocationMode: 'shortcut-fallback',
        typoGuardTriggered: true,
      },
    };
  }

  return {
    finalArgs: ['ai', 'ask', ...rawArgs],
    metadata: {
      invocationMode: 'shortcut-fallback',
      typoGuardTriggered: false,
    },
  };
}

export async function promptTypoResolution(
  input: string,
  suggestion: string,
): Promise<ShortcutChoice> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = (
      await rl.question(
        `Unknown command '${input}'. Did you mean '${suggestion}'? [c]ommand / [a]i / [x] cancel: `,
      )
    )
      .trim()
      .toLowerCase();
    if (answer === 'c' || answer === 'command') return 'run-command';
    if (answer === 'x' || answer === 'cancel') return 'cancel';
    return 'ask-ai';
  } finally {
    rl.close();
  }
}

function suggestLikelyCommand(
  input: string,
  knownCommands: Set<string>,
): string | null {
  const normalizedInput = input.toLowerCase();
  let best: { command: string; distance: number } | null = null;
  for (const command of knownCommands) {
    const normalizedCommand = command.toLowerCase();
    const distance = levenshtein(normalizedInput, normalizedCommand);
    if (!best || distance < best.distance) {
      best = { command, distance };
    }
  }
  if (!best) return null;

  const prefixLike =
    best.command.startsWith(input) || input.startsWith(best.command);
  if (best.distance <= 2 || prefixLike) {
    return best.command;
  }

  return null;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const previous = Array.from({ length: b.length + 1 }, (_, idx) => idx);
  const current = new Array<number>(b.length + 1).fill(0);

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + cost,
      );
    }
    for (let j = 0; j <= b.length; j++) {
      previous[j] = current[j];
    }
  }

  return previous[b.length];
}
