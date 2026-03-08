import { openUrl } from '../lib/browser';
import { DUBSTACK_DOCS_URL } from '../lib/external-links';

export async function docs(): Promise<void> {
  await openUrl(DUBSTACK_DOCS_URL);
}
