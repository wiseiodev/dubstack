import { openRepositoryInBrowser } from '../lib/github';

export async function repo(cwd: string): Promise<void> {
  await openRepositoryInBrowser(cwd);
}
