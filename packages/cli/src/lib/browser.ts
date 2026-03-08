import { execa } from 'execa';
import { DubError } from './errors';

export async function openUrl(
  url: string,
  options: { platform?: NodeJS.Platform } = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const opener = resolveOpener(platform);

  try {
    await execa(opener, [url], { stdio: 'ignore' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DubError(`Failed to open '${url}' in your browser: ${message}`);
  }
}

function resolveOpener(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'open';
  if (platform === 'linux') return 'xdg-open';
  throw new DubError(`Unsupported platform '${platform}' for browser opening.`);
}
