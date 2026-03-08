import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/browser.js', () => ({
  openUrl: vi.fn(),
}));

import { openUrl } from '../lib/browser';
import { DUBSTACK_DOCS_URL } from '../lib/external-links';
import { docs } from './docs';

const mockOpenUrl = openUrl as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockOpenUrl.mockResolvedValue(undefined);
});

describe('docs', () => {
  it('opens the shared docs URL constant', async () => {
    await docs();
    expect(mockOpenUrl).toHaveBeenCalledWith(DUBSTACK_DOCS_URL);
  });
});
