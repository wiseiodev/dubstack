import { checkGhAuth, ensureGhInstalled, openPrInBrowser } from '../lib/github';

export async function pr(cwd: string, branch?: string): Promise<void> {
  await ensureGhInstalled();
  await checkGhAuth();
  await openPrInBrowser(cwd, branch);
}
