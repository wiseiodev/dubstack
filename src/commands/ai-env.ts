import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DubError } from '../lib/errors';

const GEMINI_KEY_NAME = 'DUBSTACK_GEMINI_API_KEY';
const GATEWAY_KEY_NAME = 'DUBSTACK_AI_GATEWAY_API_KEY';
const GEMINI_MODEL_NAME = 'DUBSTACK_GEMINI_MODEL';
const GATEWAY_MODEL_NAME = 'DUBSTACK_AI_GATEWAY_MODEL';

interface ConfigureAiEnvOptions {
  geminiKey?: string;
  gatewayKey?: string;
  geminiModel?: string;
  gatewayModel?: string;
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
  if (
    !options.geminiKey &&
    !options.gatewayKey &&
    !options.geminiModel &&
    !options.gatewayModel
  ) {
    throw new DubError(
      'Provide at least one key or model via --gemini-key, --gateway-key, --gemini-model, or --gateway-model.',
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

  if (options.geminiModel !== undefined) {
    const model = normalizeGeminiModel(options.geminiModel);
    content = upsertExport(content, GEMINI_MODEL_NAME, model);
    updated.push(GEMINI_MODEL_NAME);
  }

  if (options.gatewayModel !== undefined) {
    const model = normalizeGatewayModel(options.gatewayModel);
    content = upsertExport(content, GATEWAY_MODEL_NAME, model);
    updated.push(GATEWAY_MODEL_NAME);
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

function normalizeGeminiModel(value: string): string {
  const model = value.trim();
  if (model.length === 0) {
    throw new DubError('Gemini model cannot be empty.');
  }
  if (model.includes('/')) {
    throw new DubError(
      "Gemini model should not include '/'. Use names like 'gemini-3-flash-preview'.",
    );
  }
  return model;
}

function normalizeGatewayModel(value: string): string {
  const model = value.trim();
  if (model.length === 0) {
    throw new DubError('Gateway model cannot be empty.');
  }
  return model;
}
