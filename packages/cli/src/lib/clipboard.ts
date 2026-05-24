import { execa } from 'execa';

/**
 * Best-effort clipboard copy. Tries `pbcopy` (macOS); `wl-copy`, `xclip`,
 * then `xsel` (Linux); and `clip` (Windows). Never throws — returns the
 * tool that succeeded, or `null` if every candidate is missing or errored.
 */
export async function copyToClipboard(text: string): Promise<string | null> {
  const candidates: Array<{ cmd: string; args: string[] }> =
    process.platform === 'darwin'
      ? [{ cmd: 'pbcopy', args: [] }]
      : process.platform === 'win32'
        ? [{ cmd: 'clip', args: [] }]
        : [
            { cmd: 'wl-copy', args: [] },
            { cmd: 'xclip', args: ['-selection', 'clipboard'] },
            { cmd: 'xsel', args: ['--clipboard', '--input'] },
          ];

  for (const { cmd, args } of candidates) {
    try {
      await execa(cmd, args, { input: text });
      return cmd;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}
