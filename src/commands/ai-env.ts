import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DubError } from '../lib/errors';

const GEMINI_KEY_NAME = 'DUBSTACK_GEMINI_API_KEY';
const GATEWAY_KEY_NAME = 'DUBSTACK_AI_GATEWAY_API_KEY';

interface ConfigureAiEnvOptions {
  geminiKey?: string;
  gatewayKey?: string;
  shell?: string;
  profile?: string;
}

interface ConfigureAiEnvResult {
  profilePath: string;
  updated: string[];
}

export async function configureAiEnv(
  options: ConfigureAiEnvOptions,
): Promise<ConfigureAiEnvResult> {
  if (!options.geminiKey && !options.gatewayKey) {
    throw new DubError(
      'Provide at least one key via --gemini-key or --gateway-key.',
    );
  }

  const profilePath = options.profile ?? resolveProfilePath(options.shell);
  const dir = path.dirname(profilePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let content = fs.existsSync(profilePath)
    ? fs.readFileSync(profilePath, 'utf-8')
    : '';
  const updated: string[] = [];

  if (options.geminiKey) {
    content = upsertExport(content, GEMINI_KEY_NAME, options.geminiKey);
    updated.push(GEMINI_KEY_NAME);
  }

  if (options.gatewayKey) {
    content = upsertExport(content, GATEWAY_KEY_NAME, options.gatewayKey);
    updated.push(GATEWAY_KEY_NAME);
  }

  if (!content.endsWith('\n')) {
    content += '\n';
  }
  fs.writeFileSync(profilePath, content);

  return { profilePath, updated };
}

function resolveProfilePath(shellOverride?: string): string {
  const home = os.homedir();
  const shellName = (shellOverride ?? process.env.SHELL ?? '').split('/').pop();

  if (shellName === 'zsh') {
    return path.join(home, '.zshrc');
  }

  if (shellName === 'bash') {
    const bashRc = path.join(home, '.bashrc');
    if (fs.existsSync(bashRc)) {
      return bashRc;
    }
    return path.join(home, '.bash_profile');
  }

  if (shellName === 'sh') {
    return path.join(home, '.profile');
  }

  throw new DubError(
    'Could not detect a supported shell profile. Use --profile <path> (supported shells: zsh, bash).',
  );
}

function upsertExport(content: string, key: string, value: string): string {
  const exportLine = `export ${key}=${quoteForShell(value)}`;
  const pattern = new RegExp(`^\\s*export\\s+${key}=.*$`, 'm');

  if (pattern.test(content)) {
    return content.replace(pattern, exportLine);
  }

  const prefix =
    content.length > 0 && !content.endsWith('\n') ? `${content}\n` : content;
  return `${prefix}${exportLine}\n`;
}

function quoteForShell(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
