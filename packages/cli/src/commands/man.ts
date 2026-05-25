import type { Command } from 'commander';
import { generateManPage } from '../lib/man';

export function man(
  program: Command,
  options: { version: string; date?: string },
): string {
  return generateManPage(program, options);
}
