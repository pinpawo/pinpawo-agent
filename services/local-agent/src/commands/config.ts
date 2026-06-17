import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface, type Interface } from 'node:readline/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { loadStoredConfig, type StoredConfig } from '../storage';

export type ConfigGuideOptions = {
  dir?: string;
  wizard?: boolean;
};

export type ConfigGuideItem = {
  key: string;
  label: string;
  required: boolean;
  status: 'ok' | 'missing' | 'placeholder';
  source?: 'env' | 'stored' | 'default';
  hint: string;
  defaultValue?: string;
  secret?: boolean;
};

export type ConfigGuideReport = {
  rootDir: string;
  envPath: string;
  items: ConfigGuideItem[];
};

const REQUIRED_KEYS = [
  {
    key: 'LLM_API_KEY',
    storedKey: 'llm_api_key',
    label: 'LLM API key',
    hint: 'Set LLM_API_KEY so the local agent can call an OpenAI-compatible model.',
    secret: true,
    placeholder: /^sk-xxx$/i,
  },
] as const;

const OPTIONAL_KEYS = [
  {
    key: 'LLM_BASE_URL',
    storedKey: 'llm_base_url',
    label: 'LLM base URL',
    hint: 'Defaults to https://api.deepseek.com when omitted.',
    defaultValue: 'https://api.deepseek.com',
  },
  {
    key: 'LLM_MODEL',
    storedKey: 'llm_model',
    label: 'LLM model',
    hint: 'Defaults to deepseek-v4-pro when omitted.',
    defaultValue: 'deepseek-v4-pro',
  },
  {
    key: 'PINPAWO_WORKDIR',
    storedKey: 'workdir',
    label: 'Local workdir',
    hint: 'Defaults to your home directory.',
    defaultValue: homedir(),
  },
] as const;

const API_KEYS = [
  {
    key: 'API_BASE_URL',
    storedKey: 'api_base_url',
    label: 'Hosted API base URL',
    hint: 'Optional for local-only mode. Run pinpawo-agent login for hosted app features.',
    placeholder: /your-api\.example\.com/i,
  },
  {
    key: 'HASURA_ENDPOINT',
    storedKey: 'hasura_endpoint',
    label: 'Hasura endpoint',
    hint: 'Optional for local-only mode. Run pinpawo-agent login for hosted app features.',
    placeholder: /your-hasura\.example\.com/i,
  },
  {
    key: 'AGENT_TOKEN',
    storedKey: 'agent_token',
    label: 'Agent token',
    hint: 'Optional for local-only mode. Run pinpawo-agent login for hosted app features.',
    placeholder: /^your-agent-token-here$/i,
    secret: true,
  },
  {
    key: 'HASURA_JWT',
    storedKey: 'hasura_jwt',
    label: 'Hasura JWT',
    hint: 'Optional for local-only mode. Run pinpawo-agent login for hosted app features.',
    placeholder: /^(eyJ\.\.\.|your-hasura-jwt)/i,
    secret: true,
  },
] as const;

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return resolve(homedir(), path.slice(2));
  return path;
}

function parseDotEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    result[key] = value;
  }
  return result;
}

function readEnvFile(envPath: string): Record<string, string> {
  try {
    return parseDotEnv(readFileSync(envPath, 'utf-8'));
  } catch {
    return {};
  }
}

function readValue(
  key: string,
  storedKey: keyof StoredConfig,
  env: Record<string, string>,
  stored: StoredConfig,
): { value: string; source?: ConfigGuideItem['source'] } {
  const envValue = process.env[key] ?? env[key];
  if (envValue) return { value: envValue, source: 'env' };
  const storedValue = stored[storedKey];
  if (typeof storedValue === 'string' && storedValue) {
    return { value: storedValue, source: 'stored' };
  }
  return { value: '' };
}

function itemStatus(value: string, placeholder?: RegExp): ConfigGuideItem['status'] {
  if (!value.trim()) return 'missing';
  if (placeholder?.test(value.trim())) return 'placeholder';
  return 'ok';
}

export function buildConfigGuideReport(
  options: ConfigGuideOptions = {},
  deps: { stored?: StoredConfig; env?: Record<string, string> } = {},
): ConfigGuideReport {
  const rootDir = resolve(expandHome(options.dir ?? '~/.pinpawo'));
  const envPath = resolve(rootDir, '.env');
  const env = deps.env ?? readEnvFile(envPath);
  const stored = deps.stored ?? loadStoredConfig();

  const items: ConfigGuideItem[] = [
    ...REQUIRED_KEYS.map((definition) => {
      const value = readValue(definition.key, definition.storedKey, env, stored);
      return {
        key: definition.key,
        label: definition.label,
        required: true,
        status: itemStatus(value.value, definition.placeholder),
        source: value.source,
        hint: definition.hint,
        secret: definition.secret,
      };
    }),
    ...OPTIONAL_KEYS.map((definition) => {
      const value = readValue(definition.key, definition.storedKey, env, stored);
      return {
        key: definition.key,
        label: definition.label,
        required: false,
        status: value.value ? 'ok' as const : 'missing' as const,
        source: value.source ?? 'default' as const,
        hint: definition.hint,
        defaultValue: definition.defaultValue,
      };
    }),
    ...API_KEYS.map((definition) => {
      const value = readValue(definition.key, definition.storedKey, env, stored);
      return {
        key: definition.key,
        label: definition.label,
        required: false,
        status: itemStatus(value.value, definition.placeholder),
        source: value.source,
        hint: definition.hint,
        secret: 'secret' in definition ? definition.secret : undefined,
      };
    }),
  ];

  return { rootDir, envPath, items };
}

function formatStatus(item: ConfigGuideItem) {
  if (item.status === 'ok') return `ok${item.source ? ` (${item.source})` : ''}`;
  if (item.status === 'placeholder') return 'placeholder';
  return item.required ? 'missing' : 'not set';
}

function upsertEnvValues(envPath: string, updates: Record<string, string>) {
  const existing = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : '';
  const lines = existing ? existing.split('\n') : [];
  const seen = new Set<string>();
  const nextLines = lines.map((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (!match) return line;
    const key = match[1]!;
    if (!(key in updates)) return line;
    seen.add(key);
    return `${key}=${updates[key]}`;
  });

  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) nextLines.push(`${key}=${value}`);
  }

  mkdirSync(dirname(envPath), { recursive: true });
  writeFileSync(envPath, `${nextLines.filter((line, index) => line || index < nextLines.length - 1).join('\n')}\n`, 'utf-8');
}

async function promptForMissingValues(report: ConfigGuideReport, rl: Interface) {
  const updates: Record<string, string> = {};
  for (const item of report.items) {
    const shouldPrompt = item.required && item.status !== 'ok'
      || (!item.required && item.defaultValue && item.status === 'missing');
    if (!shouldPrompt) continue;
    const suffix = item.defaultValue ? ` [${item.defaultValue}]` : '';
    const answer = (await rl.question(`${item.label} (${item.key})${suffix}: `)).trim();
    const value = answer || item.defaultValue || '';
    if (value) updates[item.key] = value;
  }
  return updates;
}

export async function runConfigGuide(options: ConfigGuideOptions = {}): Promise<void> {
  const report = buildConfigGuideReport(options);
  process.stdout.write(`PinPawo config guide: ${report.rootDir}\n`);
  for (const item of report.items) {
    process.stdout.write(`- ${item.key}: ${formatStatus(item)} — ${item.hint}\n`);
  }

  const blocking = report.items.filter((item) => item.required && item.status !== 'ok');
  if (!options.wizard) {
    process.stdout.write(blocking.length > 0
      ? '\nRun "pinpawo-agent config --wizard" to fill missing values, or edit the .env file directly.\n'
      : '\nRequired local LLM config is ready. Run "pinpawo-agent tui" to start.\n');
    return;
  }

  const rl = createInterface({ input, output });
  try {
    const updates = await promptForMissingValues(report, rl);
    if (Object.keys(updates).length === 0) {
      process.stdout.write('No changes written.\n');
      return;
    }
    upsertEnvValues(report.envPath, updates);
    process.stdout.write(`Updated ${report.envPath}\n`);
    process.stdout.write('Next step: run "pinpawo-agent tui"\n');
  } finally {
    rl.close();
  }
}
