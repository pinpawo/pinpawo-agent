import { createInterface } from 'node:readline/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { inferLlmContextWindowTokens } from '../llmContextWindow';
import { loadStoredConfig, saveStoredConfig, configPath } from '../storage';

type AuthResponse = {
  accessToken: string;
  user: { id: string; nickname: string };
};

type TokenResponse = {
  token: string;
  hasura_jwt: string;
  label: string;
};

async function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return (await rl.question(question)).trim();
}

function maskSecret(value: string): string {
  if (!value) return '';
  if (value.length <= 12) return `${value.slice(0, 4)}...`;
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function normalizeOptionalInput(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed === '-' || trimmed.toLowerCase() === 'clear') return '';
  return trimmed;
}

function parsePositiveInteger(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value.trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function formatContextWindow(value: number | undefined): string {
  return typeof value === 'number'
    ? new Intl.NumberFormat('zh-CN').format(value)
    : '手动填写';
}

function fail(message: string): never {
  throw new Error(message);
}

function isValidMediaCrawlerDir(dir: string): boolean {
  return existsSync(resolve(dir, 'main.py'));
}

async function apiPost<T>(url: string, body: unknown, authToken?: string): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const json = await res.json();

  if (!res.ok) {
    const msg = (json as { message?: string; error?: string }).message
      ?? (json as { message?: string; error?: string }).error
      ?? res.statusText;
    throw new Error(`${res.status}: ${msg}`);
  }
  return json as T;
}

export async function runLogin() {
  const rl = createInterface({ input, output });

  try {
    const stored = loadStoredConfig();

    console.log('\nPinPawo Local Agent — Login\n');

    // API base URL
    const defaultApi = stored.api_base_url ?? process.env.API_BASE_URL ?? 'https://a.ai.hughub.cn';
    let apiBaseUrl = await prompt(rl, `API URL${defaultApi ? ` [${defaultApi}]` : ''}: `);
    if (!apiBaseUrl && defaultApi) apiBaseUrl = defaultApi;
    if (!apiBaseUrl) {
      fail('API URL is required.');
    }
    apiBaseUrl = apiBaseUrl.replace(/\/$/, '');

    // Hasura endpoint
    const defaultHasura = stored.hasura_endpoint ?? process.env.HASURA_ENDPOINT ?? '';
    let hasuraEndpoint = await prompt(rl, `Hasura GraphQL URL${defaultHasura ? ` [${defaultHasura}]` : ''}: `);
    if (!hasuraEndpoint && defaultHasura) hasuraEndpoint = defaultHasura;
    if (!hasuraEndpoint) {
      fail('Hasura GraphQL URL is required.');
    }
    hasuraEndpoint = hasuraEndpoint.replace(/\/$/, '');

    // Phone
    const phone = await prompt(rl, 'Phone number (e.g. 13800138000): ');
    if (!phone) {
      fail('Phone number is required.');
    }

    // Send SMS
    process.stdout.write('Sending SMS code...');
    await apiPost(`${apiBaseUrl}/auth/sms/request`, { phone });
    console.log(' sent.');

    // Verify SMS
    const code = await prompt(rl, 'Enter the 6-digit SMS code: ');
    if (!code) {
      fail('Code is required.');
    }

    process.stdout.write('Verifying...');
    const authRes = await apiPost<AuthResponse>(`${apiBaseUrl}/auth/sms/verify`, { phone, code });
    console.log(` welcome, ${authRes.user.nickname}!`);

    // Exchange for agent token + hasura JWT
    process.stdout.write('Generating agent credentials...');
    const tokenRes = await apiPost<TokenResponse>(
      `${apiBaseUrl}/local-agent/token`,
      { label: 'CLI Login' },
      authRes.accessToken
    );
    console.log(' done.');

    // LLM configuration
    console.log('\nLLM Configuration (OpenAI-compatible API):');
    const defaultLlmKey = stored.llm_api_key ?? process.env.LLM_API_KEY ?? '';
    const defaultLlmBase = stored.llm_base_url ?? process.env.LLM_BASE_URL ?? 'https://api.deepseek.com';
    const defaultLlmModel = stored.llm_model ?? process.env.LLM_MODEL ?? 'deepseek-v4-pro';
    const defaultLlmContextWindow =
      stored.llm_context_window_tokens
      ?? parsePositiveInteger(process.env.LLM_CONTEXT_WINDOW_TOKENS)
      ?? inferLlmContextWindowTokens(defaultLlmModel);

    let llmApiKey = await prompt(rl, `LLM API Key${defaultLlmKey ? ' [already set, press Enter to keep]' : ''}: `);
    if (!llmApiKey && defaultLlmKey) llmApiKey = defaultLlmKey;
    if (!llmApiKey) {
      fail('LLM API Key is required.');
    }

    let llmBaseUrl = await prompt(rl, `LLM Base URL [${defaultLlmBase}]: `);
    if (!llmBaseUrl) llmBaseUrl = defaultLlmBase;

    let llmModel = await prompt(rl, `LLM Model [${defaultLlmModel}]: `);
    if (!llmModel) llmModel = defaultLlmModel;

    const inferredContextWindow = inferLlmContextWindowTokens(llmModel);
    let llmContextWindow = await prompt(
      rl,
      inferredContextWindow || defaultLlmContextWindow
        ? `LLM Context Window Tokens [${formatContextWindow(inferredContextWindow ?? defaultLlmContextWindow ?? undefined)}]: `
        : 'LLM Context Window Tokens (custom model, required): ',
    );
    if (!llmContextWindow) {
      if (inferredContextWindow ?? defaultLlmContextWindow) {
        llmContextWindow = String(inferredContextWindow ?? defaultLlmContextWindow);
      } else {
        fail('LLM Context Window Tokens are required for an unknown model.');
      }
    }
    const parsedContextWindow = parsePositiveInteger(llmContextWindow);
    if (parsedContextWindow === null) {
      fail('LLM Context Window Tokens must be a positive integer.');
    }

    // MediaCrawler configuration (optional)
    console.log('\nMediaCrawler Configuration (optional):');
    const defaultCrawlerDir = stored.mediacrawler_dir ?? process.env.MEDIACRAWLER_DIR ?? '';
    const defaultXhsCookie = stored.xhs_cookie ?? process.env.XHS_COOKIE ?? '';

    console.log('Press Enter to keep existing value. Enter "-" to clear an existing value.');

    let mediaCrawlerDir = defaultCrawlerDir;
    const mediaCrawlerDirInput = normalizeOptionalInput(
      await prompt(
        rl,
        `MediaCrawler directory${defaultCrawlerDir ? ` [${defaultCrawlerDir}]` : ' (e.g. /Users/you/MediaCrawler)'}: `
      )
    );
    if (mediaCrawlerDirInput !== null) {
      mediaCrawlerDir = mediaCrawlerDirInput;
    }
    if (mediaCrawlerDir && !isValidMediaCrawlerDir(mediaCrawlerDir)) {
      fail(`MediaCrawler directory is invalid: ${mediaCrawlerDir}\nExpected to find main.py in that directory.`);
    }

    let xhsCookie = defaultXhsCookie;
    if (mediaCrawlerDir) {
      const cookieLabel = defaultXhsCookie
        ? ` [configured: ${maskSecret(defaultXhsCookie)}]`
        : ' (web_session=...)';
      const xhsCookieInput = normalizeOptionalInput(
        await prompt(rl, `XHS Cookie${cookieLabel}: `)
      );
      if (xhsCookieInput !== null) {
        xhsCookie = xhsCookieInput;
      }
    } else if (defaultXhsCookie) {
      console.log('Skipping XHS Cookie because MediaCrawler directory is empty.');
    }

    // Save config
    const nextConfig = {
      ...stored,
      api_base_url: apiBaseUrl,
      hasura_endpoint: hasuraEndpoint,
      agent_token: tokenRes.token,
      hasura_jwt: tokenRes.hasura_jwt,
      user_id: authRes.user.id,
      nickname: authRes.user.nickname,
      llm_api_key: llmApiKey,
      llm_base_url: llmBaseUrl,
      llm_model: llmModel,
      llm_context_window_tokens: parsedContextWindow,
      mediacrawler_dir: mediaCrawlerDir || undefined,
      xhs_cookie: xhsCookie || undefined,
    };
    saveStoredConfig(nextConfig);

    console.log(`\nConfig saved to: ${configPath()}`);
    console.log(`LLM: ${llmModel} @ ${llmBaseUrl}`);
    if (mediaCrawlerDir) {
      console.log(`MediaCrawler: ${mediaCrawlerDir}`);
      console.log(`XHS Cookie: ${xhsCookie ? `configured (${maskSecret(xhsCookie)})` : 'not set; QR code login will be used'}`);
    } else {
      console.log('MediaCrawler: disabled');
    }
    console.log('Run "pinpawo-agent actor" to choose an actor, then "pinpawo-agent run" to start the agent.\n');
  } finally {
    rl.close();
  }
}
