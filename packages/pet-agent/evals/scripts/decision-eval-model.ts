import { ChatOpenAI } from '@langchain/openai';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { AgentModels } from '../../src/types/agent.ts';
import type { StructuredOutputMethod } from '../../src/utils/structuredOutput.ts';
import { inferStructuredOutputMethod } from '../../src/utils/structuredOutput.ts';
import type {
  PromptEvalModelMetadata,
  PromptEvalModelRole,
} from '../prompt-eval-report.ts';
import type { PromptEvalPricing } from '../prompt-eval-usage.ts';

export type EvalModelInputModality = 'text' | 'image';

type StoredEvalModelProfile = {
  id: string;
  label: string;
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  contextWindowTokens: number;
  maxOutputTokens?: number;
  structuredOutputMethod?: StructuredOutputMethod;
  inputModalities?: EvalModelInputModality[];
};

type StoredEvalModelProfiles = {
  version: 1;
  defaultProfileId: string;
  profiles: Record<string, StoredEvalModelProfile>;
};

type EvalModelEnvironment = NodeJS.ProcessEnv;

const PROFILE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,63})$/;

function readStructuredOutputMethod(
  value: string | undefined,
): StructuredOutputMethod | undefined {
  if (!value) return undefined;
  if (value === 'functionCalling' || value === 'jsonMode' || value === 'jsonSchema') {
    return value;
  }
  throw new Error(`Invalid decision structured output method: ${value}`);
}

function readConfig(configPath: string): {
  models?: StoredEvalModelProfiles;
} {
  try {
    return JSON.parse(readFileSync(configPath, 'utf8')) as {
      models?: StoredEvalModelProfiles;
    };
  } catch (error) {
    throw new Error(
      `Could not read model profiles from ${configPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function readFiniteNumber(
  name: string,
  value: string | undefined,
  fallback?: number,
): number {
  if (value === undefined && fallback !== undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid ${name}: ${value ?? ''}`);
  }
  return parsed;
}

function sanitizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Model profile baseUrl must use HTTP(S): ${value}`);
  }
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function projectEndpointOrigin(value: string) {
  const url = new URL(value);
  return url.origin;
}

function inferModelFamily(model: string): string {
  const normalized = model.toLowerCase();
  const knownFamilies = [
    'qwen',
    'gpt',
    'o1',
    'o3',
    'o4',
    'claude',
    'gemini',
    'deepseek',
    'kimi',
    'glm',
    'minimax',
  ];
  return knownFamilies.find((family) => normalized.includes(family))
    ?? normalized.split(/[-/:]/)[0]
    ?? 'unknown';
}

function readInputModalities(
  profileId: string,
  value: unknown,
): EvalModelInputModality[] {
  if (value === undefined) return ['text'];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Model profile "${profileId}" inputModalities must be a non-empty array.`);
  }
  const modalities: EvalModelInputModality[] = [];
  for (const item of value) {
    if (item !== 'text' && item !== 'image') {
      throw new Error(
        `Model profile "${profileId}" has unsupported input modality ${JSON.stringify(item)}.`,
      );
    }
    if (!modalities.includes(item)) modalities.push(item);
  }
  if (!modalities.includes('text')) {
    throw new Error(`Model profile "${profileId}" inputModalities must include "text".`);
  }
  return modalities;
}

function readProfile(
  profileId: string,
  env: EvalModelEnvironment,
): StoredEvalModelProfile & {
  inputModalities: EvalModelInputModality[];
} {
  if (!profileId.trim()) throw new Error('Model profile id is required.');
  if (!PROFILE_ID_PATTERN.test(profileId)) {
    throw new Error(
      'Model profile id must use 1-64 lowercase letters, digits, dot, underscore, '
      + 'or hyphen.',
    );
  }
  const configPath = resolve(
    env.PROMPT_EVAL_CONFIG_PATH
      ?? resolve(homedir(), '.pinpawo', 'config.json'),
  );
  const models = readConfig(configPath).models;
  if (!models || models.version !== 1 || !models.profiles) {
    throw new Error(
      `Prompt eval requires a version 1 models configuration in ${configPath}.`,
    );
  }
  const profile = models.profiles[profileId];
  if (!profile) {
    throw new Error(`Unknown model profile "${profileId}" in ${configPath}.`);
  }
  if (profile.id !== profileId) {
    throw new Error(
      `Model profile record key "${profileId}" does not match id "${profile.id}".`,
    );
  }
  for (const [field, value] of Object.entries({
    label: profile.label,
    provider: profile.provider,
    model: profile.model,
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
  })) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`Model profile "${profileId}" ${field} must be a non-empty string.`);
    }
  }
  if (
    !Number.isInteger(profile.contextWindowTokens)
    || profile.contextWindowTokens <= 0
  ) {
    throw new Error(
      `Model profile "${profileId}" contextWindowTokens must be a positive integer.`,
    );
  }
  if (
    profile.maxOutputTokens !== undefined
    && (
      !Number.isInteger(profile.maxOutputTokens)
      || profile.maxOutputTokens <= 0
    )
  ) {
    throw new Error(
      `Model profile "${profileId}" maxOutputTokens must be a positive integer.`,
    );
  }
  if (
    profile.structuredOutputMethod !== undefined
    && readStructuredOutputMethod(profile.structuredOutputMethod) === undefined
  ) {
    throw new Error(
      `Model profile "${profileId}" structuredOutputMethod is invalid.`,
    );
  }
  return {
    ...profile,
    baseUrl: sanitizeBaseUrl(profile.baseUrl),
    inputModalities: readInputModalities(profileId, profile.inputModalities),
  };
}

function fingerprintProfile(
  profile: StoredEvalModelProfile & {
    inputModalities: EvalModelInputModality[];
  },
): string {
  const sanitized = {
    provider: profile.provider,
    model: profile.model,
    endpoint: sanitizeBaseUrl(profile.baseUrl),
    contextWindowTokens: profile.contextWindowTokens,
    maxOutputTokens: profile.maxOutputTokens ?? null,
    structuredOutputMethod: profile.structuredOutputMethod
      ?? inferStructuredOutputMethod(profile.model, profile.baseUrl)
      ?? null,
    inputModalities: [...profile.inputModalities].sort(),
  };
  return createHash('sha256')
    .update(JSON.stringify(sanitized))
    .digest('hex');
}

function readPricing(
  profileId: string,
  role: PromptEvalModelRole,
  env: EvalModelEnvironment,
): PromptEvalPricing | null {
  const pricingJson = env.PROMPT_EVAL_PRICING_JSON;
  if (pricingJson) {
    const pricingByProfile = JSON.parse(pricingJson) as Record<
      string,
      {
        inputUsdPerMillionTokens?: unknown;
        outputUsdPerMillionTokens?: unknown;
      }
    >;
    const pricing = pricingByProfile[profileId];
    if (!pricing) return null;
    return {
      inputUsdPerMillionTokens: readFiniteNumber(
        `${profileId}.inputUsdPerMillionTokens`,
        String(pricing.inputUsdPerMillionTokens),
      ),
      outputUsdPerMillionTokens: readFiniteNumber(
        `${profileId}.outputUsdPerMillionTokens`,
        String(pricing.outputUsdPerMillionTokens),
      ),
    };
  }

  if (role === 'judge') return null;
  const input = env.PROMPT_EVAL_INPUT_USD_PER_MILLION;
  const output = env.PROMPT_EVAL_OUTPUT_USD_PER_MILLION;
  if (input === undefined && output === undefined) return null;
  if (input === undefined || output === undefined) {
    throw new Error(
      'Set both PROMPT_EVAL_INPUT_USD_PER_MILLION and '
      + 'PROMPT_EVAL_OUTPUT_USD_PER_MILLION.',
    );
  }
  return {
    inputUsdPerMillionTokens: readFiniteNumber(
      'PROMPT_EVAL_INPUT_USD_PER_MILLION',
      input,
    ),
    outputUsdPerMillionTokens: readFiniteNumber(
      'PROMPT_EVAL_OUTPUT_USD_PER_MILLION',
      output,
    ),
  };
}

export type DecisionEvalModel = {
  model: AgentModels['act'];
  method: StructuredOutputMethod | undefined;
  label: string;
  metadata: PromptEvalModelMetadata;
  pricing: PromptEvalPricing | null;
};

export function createDecisionEvalModel(options: {
  profileId: string;
  role: PromptEvalModelRole;
  env?: EvalModelEnvironment;
}): DecisionEvalModel {
  const env = options.env ?? process.env;
  const profile = readProfile(options.profileId, env);
  const rolePrefix = options.role === 'judge'
    ? 'PROMPT_EVAL_JUDGE'
    : 'PROMPT_EVAL_SUBJECT';
  const timeoutName = `${rolePrefix}_TIMEOUT_MS`;
  const timeout = readFiniteNumber(
    timeoutName,
    env[timeoutName] ?? env.DECISION_EVAL_TIMEOUT_MS,
    120_000,
  );
  if (timeout <= 0) throw new Error(`${timeoutName} must be greater than zero.`);
  const temperatureName = `${rolePrefix}_TEMPERATURE`;
  const temperature = readFiniteNumber(
    temperatureName,
    env[temperatureName] ?? (
      options.role === 'subject' ? env.PROMPT_EVAL_TEMPERATURE : undefined
    ),
    0,
  );
  const reasoningEffort = env[`${rolePrefix}_REASONING_EFFORT`]
    ?? (options.role === 'subject'
      ? env.PROMPT_EVAL_REASONING_EFFORT
      : undefined)
    ?? 'provider-default';
  const method = readStructuredOutputMethod(
    env[`${rolePrefix}_STRUCTURED_OUTPUT_METHOD`]
      ?? (options.role === 'subject'
        ? env.DECISION_EVAL_STRUCTURED_OUTPUT_METHOD
          ?? env.DECISION_STRUCTURED_OUTPUT_METHOD
        : undefined),
  ) ?? profile.structuredOutputMethod
    ?? inferStructuredOutputMethod(profile.model, profile.baseUrl);
  const fingerprint = fingerprintProfile(profile);

  return {
    model: new ChatOpenAI({
      model: profile.model,
      temperature,
      timeout,
      maxRetries: 0,
      apiKey: profile.apiKey,
      configuration: {
        baseURL: profile.baseUrl,
        defaultHeaders: { Authorization: `Bearer ${profile.apiKey}` },
      },
      ...(profile.maxOutputTokens
        ? { maxTokens: profile.maxOutputTokens }
        : {}),
      ...(reasoningEffort === 'provider-default'
        ? {}
        : { modelKwargs: { reasoning_effort: reasoningEffort } }),
    }) as unknown as AgentModels['act'],
    method,
    label: `${profile.label} (${profile.model} @ ${new URL(profile.baseUrl).host})`,
    metadata: {
      role: options.role,
      profileId: profile.id,
      fingerprint,
      provider: profile.provider,
      family: inferModelFamily(profile.model),
      model: profile.model,
      // Reports and telemetry expose only the origin. The full endpoint path
      // remains host-private and contributes only through the fingerprint.
      endpointOrigin: projectEndpointOrigin(profile.baseUrl),
      contextWindowTokens: profile.contextWindowTokens,
      maxOutputTokens: profile.maxOutputTokens ?? null,
      temperature,
      reasoningEffort,
      timeoutMs: timeout,
      inputModalities: [...profile.inputModalities],
    },
    pricing: readPricing(profile.id, options.role, env),
  };
}
