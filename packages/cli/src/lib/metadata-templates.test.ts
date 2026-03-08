import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from 'vitest';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

import { execa } from 'execa';
import { readMetadataTemplates } from './metadata-templates';

const mockExeca = execa as unknown as MockInstance;

let dir: string;

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'dubstack-templates-'),
  );
  vi.clearAllMocks();
});

afterEach(async () => {
  await fs.promises.rm(dir, { recursive: true, force: true });
});

describe('readMetadataTemplates', () => {
  it('loads the default pull request template from .github', async () => {
    await fs.promises.mkdir(path.join(dir, '.github'), { recursive: true });
    await fs.promises.writeFile(
      path.join(dir, '.github', 'pull_request_template.md'),
      '## Summary\n\n- item\n',
    );
    mockExeca.mockRejectedValueOnce(new Error('no commit template'));

    const result = await readMetadataTemplates(dir);

    expect(result.prTemplate).toContain('## Summary');
    expect(result.commitTemplate).toBeNull();
  });

  it('loads a pull request template from .github/PULL_REQUEST_TEMPLATE', async () => {
    await fs.promises.mkdir(
      path.join(dir, '.github', 'PULL_REQUEST_TEMPLATE'),
      {
        recursive: true,
      },
    );
    await fs.promises.writeFile(
      path.join(dir, '.github', 'PULL_REQUEST_TEMPLATE', 'feature.md'),
      '## Feature template\n',
    );
    mockExeca.mockRejectedValueOnce(new Error('no commit template'));

    const result = await readMetadataTemplates(dir);

    expect(result.prTemplate).toContain('## Feature template');
  });

  it('loads the configured commit template from git config', async () => {
    await fs.promises.writeFile(
      path.join(dir, '.gitmessage'),
      'feat(scope): summary\n\n## Testing\n- [ ] added\n',
    );
    mockExeca.mockResolvedValueOnce({
      stdout: '.gitmessage\n',
    });

    const result = await readMetadataTemplates(dir);

    expect(mockExeca).toHaveBeenCalledWith(
      'git',
      ['config', '--get', 'commit.template'],
      { cwd: dir },
    );
    expect(result.commitTemplate).toContain('## Testing');
    expect(result.prTemplate).toBeNull();
  });

  it('returns null templates when nothing is configured', async () => {
    mockExeca.mockRejectedValueOnce(new Error('not set'));

    const result = await readMetadataTemplates(dir);

    expect(result).toEqual({
      prTemplate: null,
      commitTemplate: null,
    });
  });
});
