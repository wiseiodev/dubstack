import { readHistory } from '../lib/history';

export interface HistoryResult {
  entries: Awaited<ReturnType<typeof readHistory>>;
}

export async function history(
  cwd: string,
  options: { limit?: number } = {},
): Promise<HistoryResult> {
  const limit = options.limit ?? 20;
  const entries = await readHistory(cwd, { limit });
  return { entries };
}

export function formatHistory(result: HistoryResult): string {
  if (result.entries.length === 0) {
    return 'No Dub command history yet.';
  }

  return result.entries
    .map((entry) => {
      const status = entry.status === 'success' ? '✔' : '✖';
      return `${status} ${entry.timestamp}  ${entry.command}`;
    })
    .join('\n');
}
