import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DubError } from '../lib/errors';

const GEMINI_KEY_NAME = 'DUBSTACK_GEMINI_API_KEY';
const GATEWAY_KEY_NAME = 'DUBSTACK_AI_GATEWAY_API_KEY';
const GEMINI_MODEL_NAME = 'DUBSTACK_GEMINI_MODEL';
const GATEWAY_MODEL_NAME = 'DUBSTACK_AI_GATEWAY_MODEL';
const BEDROCK_PROFILE_NAME = 'DUBSTACK_BEDROCK_AWS_PROFILE';
const BEDROCK_REGION_NAME = 'DUBSTACK_BEDROCK_AWS_REGION';
const BEDROCK_MODEL_NAME = 'DUBSTACK_BEDROCK_MODEL';

export interface ConfigureAiEnvOptions {
  geminiKey?: string;
  gatewayKey?: string;
  geminiModel?: string;
  gatewayModel?: string;
  bedrockProfile?: string;
  bedrockRegion?: string;
  bedrockModel?: string;
  shell?: string;
  profile?: string;
}

export interface ConfigureAiEnvResult {
  profilePath: string;
  updated: string[];
  activationCommand: string;
}

export async function configureAiEnv(
  options: ConfigureAiEnvOptions,
): Promise<ConfigureAiEnvResult> {
  if (
    !options.geminiKey &&
    !options.gatewayKey &&
    !options.geminiModel &&
    !options.gatewayModel &&
    !options.bedrockProfile &&
    !options.bedrockRegion &&
    !options.bedrockModel
  ) {
    throw new DubError(
      'Provide at least one key, model, or Bedrock setting via --gemini-key, --gateway-key, --gemini-model, --gateway-model, --bedrock-profile, --bedrock-region, or --bedrock-model.',
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
  const appliedValues: Record<string, string> = {};

  if (options.geminiKey) {
    content = upsertExport(content, GEMINI_KEY_NAME, options.geminiKey);
    updated.push(GEMINI_KEY_NAME);
    appliedValues[GEMINI_KEY_NAME] = options.geminiKey;
  }

  if (options.gatewayKey) {
    content = upsertExport(content, GATEWAY_KEY_NAME, options.gatewayKey);
    updated.push(GATEWAY_KEY_NAME);
    appliedValues[GATEWAY_KEY_NAME] = options.gatewayKey;
  }

  if (options.geminiModel !== undefined) {
    const model = normalizeGeminiModel(options.geminiModel);
    content = upsertExport(content, GEMINI_MODEL_NAME, model);
    updated.push(GEMINI_MODEL_NAME);
    appliedValues[GEMINI_MODEL_NAME] = model;
  }

  if (options.gatewayModel !== undefined) {
    const model = normalizeGatewayModel(options.gatewayModel);
    content = upsertExport(content, GATEWAY_MODEL_NAME, model);
    updated.push(GATEWAY_MODEL_NAME);
    appliedValues[GATEWAY_MODEL_NAME] = model;
  }

  if (options.bedrockProfile !== undefined) {
    const profile = normalizeBedrockProfile(options.bedrockProfile);
    content = upsertExport(content, BEDROCK_PROFILE_NAME, profile);
    updated.push(BEDROCK_PROFILE_NAME);
    appliedValues[BEDROCK_PROFILE_NAME] = profile;
  }

  if (options.bedrockRegion !== undefined) {
    const region = normalizeBedrockRegion(options.bedrockRegion);
    content = upsertExport(content, BEDROCK_REGION_NAME, region);
    updated.push(BEDROCK_REGION_NAME);
    appliedValues[BEDROCK_REGION_NAME] = region;
  }

  if (options.bedrockModel !== undefined) {
    const model = normalizeBedrockModel(options.bedrockModel);
    content = upsertExport(content, BEDROCK_MODEL_NAME, model);
    updated.push(BEDROCK_MODEL_NAME);
    appliedValues[BEDROCK_MODEL_NAME] = model;
  }

  if (!content.endsWith('\n')) {
    content += '\n';
  }
  fs.writeFileSync(profilePath, content);

  applyEnvToCurrentProcess(appliedValues);

  return {
    profilePath,
    updated,
    activationCommand: buildActivationCommand(profilePath, options.shell),
  };
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

function applyEnvToCurrentProcess(values: Record<string, string>): void {
  for (const [key, value] of Object.entries(values)) {
    process.env[key] = value;
  }
}

function buildActivationCommand(
  profilePath: string,
  shellOverride?: string,
): string {
  const shellKind = detectShellKind(shellOverride, profilePath);
  const command = shellKind === 'sh' ? '.' : 'source';
  return `${command} ${quoteForShell(profilePath)}`;
}

function detectShellKind(
  shellOverride: string | undefined,
  profilePath: string,
): 'zsh' | 'bash' | 'sh' {
  const shellName =
    shellOverride?.split('/').pop() ??
    inferShellNameFromProfile(profilePath) ??
    process.env.SHELL?.split('/').pop() ??
    'sh';

  if (shellName === 'zsh') {
    return 'zsh';
  }

  if (shellName === 'bash') {
    return 'bash';
  }

  return 'sh';
}

function inferShellNameFromProfile(profilePath: string): string | null {
  const profileName = path.basename(profilePath);
  if (profileName === '.zshrc') {
    return 'zsh';
  }

  if (profileName === '.bashrc' || profileName === '.bash_profile') {
    return 'bash';
  }

  if (profileName === '.profile') {
    return 'sh';
  }

  return null;
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

function normalizeBedrockProfile(value: string): string {
  const profile = value.trim();
  if (profile.length === 0) {
    throw new DubError('Bedrock profile cannot be empty.');
  }
  return profile;
}

function normalizeBedrockRegion(value: string): string {
  const region = value.trim();
  if (region.length === 0) {
    throw new DubError('Bedrock region cannot be empty.');
  }
  return region;
}

function normalizeBedrockModel(value: string): string {
  const model = value.trim();
  if (model.length === 0) {
    throw new DubError('Bedrock model cannot be empty.');
  }
  return model;
}
