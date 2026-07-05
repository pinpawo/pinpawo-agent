import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

type EnvMap = Record<string, string>;

export type LangfuseConfig = {
  baseUrl: string;
  publicKey: string;
  secretKey: string;
};

const DEFAULT_ENV_FILE = fileURLToPath(
  new URL('../../../../infra/langfuse/.env', import.meta.url),
);

function parseEnvFile(path: string): EnvMap {
  try {
    const raw = readFileSync(path, 'utf8');
    const env: EnvMap = {};
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const separator = trimmed.indexOf('=');
      if (separator < 0) continue;
      const key = trimmed.slice(0, separator).trim();
      let value = trimmed.slice(separator + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      env[key] = value;
    }
    return env;
  } catch {
    return {};
  }
}

function envValue(envFile: EnvMap, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name] ?? envFile[name];
    if (value?.trim()) return value.trim();
  }
  return undefined;
}

export function resolveLangfuseConfig(): LangfuseConfig {
  const envFilePath = process.env.LANGFUSE_ENV_FILE || DEFAULT_ENV_FILE;
  const envFile = parseEnvFile(envFilePath);
  const baseUrl = envValue(
    envFile,
    'LANGFUSE_BASEURL',
    'LANGFUSE_BASE_URL',
    'LANGFUSE_HOST',
    'NEXTAUTH_URL',
  ) ?? 'http://localhost:3000';
  const publicKey = envValue(
    envFile,
    'LANGFUSE_PUBLIC_KEY',
    'LANGFUSE_INIT_PROJECT_PUBLIC_KEY',
  );
  const secretKey = envValue(
    envFile,
    'LANGFUSE_SECRET_KEY',
    'LANGFUSE_INIT_PROJECT_SECRET_KEY',
  );

  if (!publicKey || !secretKey) {
    throw new Error(
      `Missing Langfuse credentials. Set LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY or provide ${envFilePath}.`,
    );
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    publicKey,
    secretKey,
  };
}

function authHeader(config: LangfuseConfig): string {
  return `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString('base64')}`;
}

export async function langfuseFetch<T>(
  config: LangfuseConfig,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${config.baseUrl}/api/public${path}`, {
    ...init,
    headers: {
      authorization: authHeader(config),
      'content-type': 'application/json',
      ...init?.headers,
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Langfuse ${init?.method ?? 'GET'} ${path} failed (${response.status}): ${text}`);
  }
  return text ? JSON.parse(text) as T : undefined as T;
}
