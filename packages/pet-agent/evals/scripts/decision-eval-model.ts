import { ChatOpenAI } from '@langchain/openai';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
// These repository-only eval scripts consume local-agent's stored Profile
// contract. Reuse the host parser and fingerprint instead of maintaining a
// second interpretation inside the published pet-agent runtime.
import {
  buildModelProfileRegistry,
  fingerprintModelProfile,
  MODEL_PROFILES_VERSION,
  resolveModelProfile,
  type ModelInputModality,
  type ModelProfileV1,
} from '../../../../services/local-agent/src/modelProfiles.ts';
import {
  buildLlmModelKwargs,
  inferLlmStructuredOutputMethod,
} from '../../../../services/local-agent/src/llmModelPresets.ts';
import type { StoredConfig } from '../../../../services/local-agent/src/storage.ts';
import type { AgentModels } from '../../src/types/agent.ts';
import type { StructuredOutputMethod } from '../../src/utils/structuredOutput.ts';
import type {
  PromptEvalModelMetadata,
  PromptEvalModelRole,
} from '../prompt-eval-report.ts';
import type { PromptEvalPricing } from '../prompt-eval-usage.ts';

export type EvalModelInputModality = ModelInputModality;

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

function readConfig(configPath: string): StoredConfig {
  try {
    return JSON.parse(readFileSync(configPath, 'utf8')) as StoredConfig;
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

function readProfile(
  profileId: string,
  env: EvalModelEnvironment,
): ModelProfileV1 {
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
  const stored = readConfig(configPath);
  const models = stored.models;
  if (
    !models
    || models.version !== MODEL_PROFILES_VERSION
    || !models.profiles
  ) {
    throw new Error(
      `Prompt eval requires a version 1 models configuration in ${configPath}.`,
    );
  }
  if (!Object.hasOwn(models.profiles, profileId)) {
    throw new Error(`Unknown model profile "${profileId}" in ${configPath}.`);
  }
  const registry = buildModelProfileRegistry({
    stored,
    env: {
      PINPAWO_MODEL_PROFILE: profileId,
    },
  });
  return resolveModelProfile(registry, profileId);
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
  const configuredReasoningEffort = env[`${rolePrefix}_REASONING_EFFORT`]
    ?? (options.role === 'subject'
      ? env.PROMPT_EVAL_REASONING_EFFORT
      : undefined)
    ?? undefined;
  const runtimeDefaultModelKwargs = buildLlmModelKwargs(profile.model, false);
  const reasoningEffort = configuredReasoningEffort
    ?? (runtimeDefaultModelKwargs ? 'disabled' : 'provider-default');
  const modelKwargs = configuredReasoningEffort
    ? { reasoning_effort: configuredReasoningEffort }
    : runtimeDefaultModelKwargs;
  const method = readStructuredOutputMethod(
    env[`${rolePrefix}_STRUCTURED_OUTPUT_METHOD`]
      ?? (options.role === 'subject'
        ? env.DECISION_EVAL_STRUCTURED_OUTPUT_METHOD
          ?? env.DECISION_STRUCTURED_OUTPUT_METHOD
        : undefined),
  ) ?? profile.structuredOutputMethod
    ?? inferLlmStructuredOutputMethod(profile.model, profile.baseUrl);
  const fingerprint = fingerprintModelProfile(profile).fingerprint;

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
      ...(modelKwargs ? { modelKwargs } : {}),
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
