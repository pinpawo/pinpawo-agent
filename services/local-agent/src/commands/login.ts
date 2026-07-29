import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { inferLlmContextWindowTokens } from '../llmContextWindow';
import {
  findLlmModelPresetByKey,
  inferLlmModelPreset,
  listLlmModelPresets,
} from '../llmModelPresets';
import {
  buildModelProfileRegistry,
  createModelProfile,
  LEGACY_DEFAULT_MODEL_PROFILE_ID,
  resolveModelProfile,
  type ModelProfileV1,
  writeDefaultModelProfile,
} from '../modelProfiles';
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

function formatPresetChoices(): string {
  return listLlmModelPresets()
    .map((preset) => {
      const context = formatContextWindow(preset.contextWindowTokens);
      const maxOutput = preset.maxOutputTokens
        ? `, max output ${formatContextWindow(preset.maxOutputTokens)}`
        : '';
      const method = preset.structuredOutputMethod ?? 'default';
      return `  - ${preset.key}: ${preset.label} (${preset.model}, context ${context}${maxOutput}, structured ${method})`;
    })
    .join('\n');
}

function fail(message: string): never {
  throw new Error(message);
}

function readCurrentModelProfile(): ModelProfileV1 | undefined {
  try {
    return resolveModelProfile(buildModelProfileRegistry({
      stored: loadStoredConfig(),
      env: process.env,
    }));
  } catch {
    return undefined;
  }
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
    const currentModelProfile = readCurrentModelProfile();

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
    console.log('Available presets:');
    console.log(formatPresetChoices());

    const defaultLlmKey = currentModelProfile?.apiKey ?? '';
    const defaultPresetKey = currentModelProfile?.sourcePreset ?? '';

    let llmPresetKey = await prompt(
      rl,
      `LLM Preset${defaultPresetKey ? ` [${defaultPresetKey}]` : ' [manual]'}: `,
    );
    if (!llmPresetKey && defaultPresetKey) llmPresetKey = defaultPresetKey;
    if (llmPresetKey.toLowerCase() === 'manual') llmPresetKey = '';
    const selectedPreset = llmPresetKey ? findLlmModelPresetByKey(llmPresetKey) : undefined;
    if (llmPresetKey && !selectedPreset) {
      fail(`Unknown LLM preset "${llmPresetKey}". Use one of: ${listLlmModelPresets().map((item) => item.key).join(', ')}`);
    }

    const defaultLlmBase = selectedPreset
      ? (selectedPreset.baseUrl ?? '')
      : (currentModelProfile?.baseUrl ?? 'https://api.deepseek.com');
    const defaultLlmModel = selectedPreset
      ? selectedPreset.model
      : (currentModelProfile?.model ?? 'deepseek-v4-pro');
    const defaultLlmContextWindow = selectedPreset?.contextWindowTokens
      ?? currentModelProfile?.contextWindowTokens
      ?? inferLlmContextWindowTokens(defaultLlmModel);

    let llmApiKey = await prompt(rl, `LLM API Key${defaultLlmKey ? ' [already set, press Enter to keep]' : ''}: `);
    if (!llmApiKey && defaultLlmKey) llmApiKey = defaultLlmKey;
    if (!llmApiKey) {
      fail('LLM API Key is required.');
    }

    let llmBaseUrl = await prompt(
      rl,
      defaultLlmBase
        ? `LLM Base URL [${defaultLlmBase}]: `
        : 'LLM Base URL (OpenAI-compatible gateway, required): ',
    );
    if (!llmBaseUrl) llmBaseUrl = defaultLlmBase;
    if (!llmBaseUrl) {
      fail('LLM Base URL is required for this preset. Use an OpenAI-compatible gateway URL.');
    }

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

    // Save config
    const defaultProfileId = stored.models?.defaultProfileId
      ?? LEGACY_DEFAULT_MODEL_PROFILE_ID;
    const resolvedPreset = selectedPreset?.key === inferLlmModelPreset(llmModel)?.key
      ? selectedPreset
      : undefined;
    const profile = createModelProfile({
      id: defaultProfileId,
      label: resolvedPreset?.label ?? llmModel,
      sourcePreset: resolvedPreset?.key,
      apiKey: llmApiKey,
      baseUrl: llmBaseUrl,
      model: llmModel,
      contextWindowTokens: parsedContextWindow,
      inputModalities: resolvedPreset?.inputModalities ?? ['text'],
    });
    const nextConfig = {
      ...writeDefaultModelProfile(stored, profile),
      api_base_url: apiBaseUrl,
      hasura_endpoint: hasuraEndpoint,
      agent_token: tokenRes.token,
      hasura_jwt: tokenRes.hasura_jwt,
      user_id: authRes.user.id,
      nickname: authRes.user.nickname,
    };
    saveStoredConfig(nextConfig);

    console.log(`\nConfig saved to: ${configPath()}`);
    console.log(`LLM: ${llmModel} @ ${llmBaseUrl}`);
    console.log('Run "pinpawo actor" to choose an actor, then "pinpawo run" to start the agent.\n');
  } finally {
    rl.close();
  }
}
