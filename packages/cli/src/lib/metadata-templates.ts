import * as fs from 'node:fs';
import * as path from 'node:path';
import { execa } from 'execa';

export interface MetadataTemplates {
  prTemplate: string | null;
  commitTemplate: string | null;
}

const PR_TEMPLATE_CANDIDATES = [
  '.github/pull_request_template.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  'docs/pull_request_template.md',
  'pull_request_template.md',
] as const;

export async function readMetadataTemplates(
  cwd: string,
): Promise<MetadataTemplates> {
  const prTemplate = await readPullRequestTemplate(cwd);
  const commitTemplate = await readCommitTemplate(cwd);
  return {
    prTemplate,
    commitTemplate,
  };
}

async function readPullRequestTemplate(cwd: string): Promise<string | null> {
  for (const relativePath of PR_TEMPLATE_CANDIDATES) {
    const fullPath = path.join(cwd, relativePath);
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      return fs.readFileSync(fullPath, 'utf8');
    }
  }

  const templateDir = path.join(cwd, '.github', 'PULL_REQUEST_TEMPLATE');
  if (!fs.existsSync(templateDir) || !fs.statSync(templateDir).isDirectory()) {
    return null;
  }

  const candidates = fs
    .readdirSync(templateDir)
    .filter((entry) => fs.statSync(path.join(templateDir, entry)).isFile())
    .sort((a, b) => a.localeCompare(b));

  if (candidates.length === 0) return null;

  return fs.readFileSync(path.join(templateDir, candidates[0]), 'utf8');
}

async function readCommitTemplate(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execa(
      'git',
      ['config', '--get', 'commit.template'],
      {
        cwd,
      },
    );
    const configuredPath = stdout.trim();
    if (configuredPath.length === 0) return null;

    const resolvedPath = path.isAbsolute(configuredPath)
      ? configuredPath
      : path.join(cwd, configuredPath);
    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
      return null;
    }
    return fs.readFileSync(resolvedPath, 'utf8');
  } catch {
    return null;
  }
}
