import { createHash } from 'node:crypto';
import type { StructuredOutputMethod } from '@pinpawo/pet-agent';
import { inferLlmContextWindowTokens } from './llmContextWindow';
import {
  findLlmModelPresetByKey,
  inferLlmModelPreset,
  inferLlmStructuredOutputMethod,
  type LlmModelPreset,
} from './llmModelPresets';
import type { StoredConfig } from './storage';

export const MODEL_PROFILES_VERSION = 1 as const;
export const LEGACY_DEFAULT_MODEL_PROFILE_ID = 'legacy-default';
export const ENV_MODEL_PROFILE_ID = 'env';

export type ModelInputModality = 'text' | 'image';

export function missingInputModalities(
  required: readonly ModelInputModality[],
  supported: readonly ModelInputModality[],
): ModelInputModality[] {
  return required.filter((modality) => !supported.includes(modality));
}

export function supportsInputModalities(
  required: readonly ModelInputModality[],
  supported: readonly ModelInputModality[],
): boolean {
  return missingInputModalities(required, supported).length === 0;
}

function effectiveInputModalities(profile: ModelProfileV1) {
  const preset = profile.sourcePreset
    ? findLlmModelPresetByKey(profile.sourcePreset)
    : undefined;
  return preset?.inputModalities ?? profile.inputModalities;
}

export type ModelProfileV1 = Readonly<{
  id: string;
  label: string;
  provider: string;
  sourcePreset?: string;
  model: string;
  baseUrl: string;
  /** Host-private credential. Never project this field to clients or telemetry. */
  apiKey: string;
  contextWindowTokens: number;
  maxOutputTokens?: number;
  structuredOutputMethod?: StructuredOutputMethod;
  inputModalities: readonly ModelInputModality[];
}>;

export type StoredModelProfilesV1 = {
  version: typeof MODEL_PROFILES_VERSION;
  defaultProfileId: string;
  profiles: Record<string, ModelProfileV1>;
};

export type ModelProfileIssue = Readonly<{
  code:
    | 'invalid_models_contract'
    | 'invalid_profile'
    | 'profile_id_mismatch'
    | 'reserved_profile_id'
    | 'incomplete_environment_profile';
  message: string;
}>;

export type ModelProfileRegistrySnapshot = Readonly<{
  version: typeof MODEL_PROFILES_VERSION;
  /** Configured default. Environment selection does not mutate this value. */
  defaultProfileId: string;
  /** Profile selected for hosts that do not provide a session-level selection. */
  selectedProfileId: string;
  profiles: Readonly<Record<string, ModelProfileV1>>;
  unavailableProfiles: Readonly<Record<string, readonly ModelProfileIssue[]>>;
}>;

export type ModelProfileSummary = Readonly<{
  id: string;
  label: string;
  provider: string;
  model: string;
  endpointHost: string;
  contextWindowTokens: number;
  inputModalities: readonly ModelInputModality[];
  available: true;
  issues: readonly string[];
}>;

export type ModelProfileFingerprint = Readonly<{
  profileId: string;
  fingerprint: string;
}>;

export class ModelProfileConfigError extends Error {
  readonly profileId?: string;
  readonly issues: readonly ModelProfileIssue[];

  constructor(
    message: string,
    options: {
      profileId?: string;
      issues?: readonly ModelProfileIssue[];
    } = {},
  ) {
    super(message);
    this.name = 'ModelProfileConfigError';
    this.profileId = options.profileId;
    this.issues = Object.freeze([...(options.issues ?? [])]);
  }
}

type EnvMap = Record<string, string | undefined>;

const PROFILE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,63})$/;
const INPUT_MODALITIES = new Set<ModelInputModality>(['text', 'image']);
const STRUCTURED_OUTPUT_METHODS = new Set<StructuredOutputMethod>([
  'functionCalling',
  'jsonMode',
  'jsonSchema',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createDictionary<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function readOwnValue<T>(
  record: Readonly<Record<string, T>>,
  key: string,
): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function readNonEmptyString(
  value: unknown,
  field: string,
  issues: ModelProfileIssue[],
): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  issues.push({
    code: 'invalid_profile',
    message: `${field} must be a non-empty string`,
  });
  return undefined;
}

function readPositiveInteger(
  value: unknown,
  field: string,
  issues: ModelProfileIssue[],
): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  issues.push({
    code: 'invalid_profile',
    message: `${field} must be a positive integer`,
  });
  return undefined;
}

function normalizeBaseUrl(
  value: unknown,
  issues: ModelProfileIssue[],
): string | undefined {
  const baseUrl = readNonEmptyString(value, 'baseUrl', issues);
  if (!baseUrl) return undefined;
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('unsupported protocol');
    }
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    issues.push({
      code: 'invalid_profile',
      message: 'baseUrl must be an absolute HTTP(S) URL',
    });
    return undefined;
  }
}

function readInputModalities(
  value: unknown,
  issues: ModelProfileIssue[],
): readonly ModelInputModality[] {
  if (value === undefined) return Object.freeze(['text'] as const);
  if (!Array.isArray(value) || value.length === 0) {
    issues.push({
      code: 'invalid_profile',
      message: 'inputModalities must be a non-empty array',
    });
    return Object.freeze(['text'] as const);
  }

  const modalities: ModelInputModality[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !INPUT_MODALITIES.has(item as ModelInputModality)) {
      issues.push({
        code: 'invalid_profile',
        message: `inputModalities contains unsupported value ${JSON.stringify(item)}`,
      });
      continue;
    }
    const modality = item as ModelInputModality;
    if (!modalities.includes(modality)) modalities.push(modality);
  }
  if (!modalities.includes('text')) {
    issues.push({
      code: 'invalid_profile',
      message: 'inputModalities must include "text"',
    });
  }
  return Object.freeze(modalities);
}

function readStructuredOutputMethod(
  value: unknown,
  issues: ModelProfileIssue[],
): StructuredOutputMethod | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value === 'string'
    && STRUCTURED_OUTPUT_METHODS.has(value as StructuredOutputMethod)
  ) {
    return value as StructuredOutputMethod;
  }
  issues.push({
    code: 'invalid_profile',
    message: 'structuredOutputMethod is not supported',
  });
  return undefined;
}

function freezeProfile(profile: ModelProfileV1): ModelProfileV1 {
  return Object.freeze({
    ...profile,
    inputModalities: Object.freeze([...profile.inputModalities]),
  });
}

export function parseModelProfile(
  value: unknown,
  expectedId?: string,
): { profile?: ModelProfileV1; issues: readonly ModelProfileIssue[] } {
  const issues: ModelProfileIssue[] = [];
  if (!isRecord(value)) {
    return {
      issues: Object.freeze([{
        code: 'invalid_profile',
        message: 'profile must be an object',
      }]),
    };
  }

  const id = readNonEmptyString(value.id, 'id', issues);
  if (id && !PROFILE_ID_PATTERN.test(id)) {
    issues.push({
      code: 'invalid_profile',
      message: 'id must use 1-64 lowercase letters, digits, dot, underscore, or hyphen',
    });
  }
  if (id && expectedId && id !== expectedId) {
    issues.push({
      code: 'profile_id_mismatch',
      message: `profile record key "${expectedId}" does not match id "${id}"`,
    });
  }

  const label = readNonEmptyString(value.label, 'label', issues);
  const model = readNonEmptyString(value.model, 'model', issues);
  const baseUrl = normalizeBaseUrl(value.baseUrl, issues);
  const apiKey = readNonEmptyString(value.apiKey, 'apiKey', issues);
  const contextWindowTokens = readPositiveInteger(
    value.contextWindowTokens,
    'contextWindowTokens',
    issues,
  );
  const maxOutputTokens = value.maxOutputTokens === undefined
    ? undefined
    : readPositiveInteger(value.maxOutputTokens, 'maxOutputTokens', issues);
  const sourcePreset = value.sourcePreset === undefined
    ? undefined
    : readNonEmptyString(value.sourcePreset, 'sourcePreset', issues);
  const provider = value.provider === undefined && model && baseUrl
    ? inferProvider(
        model,
        baseUrl,
        sourcePreset ? findLlmModelPresetByKey(sourcePreset) : undefined,
      )
    : readNonEmptyString(value.provider, 'provider', issues);
  const structuredOutputMethod = readStructuredOutputMethod(
    value.structuredOutputMethod,
    issues,
  );
  const inputModalities = readInputModalities(value.inputModalities, issues);

  if (
    issues.length > 0
    || !id
    || !label
    || !provider
    || !model
    || !baseUrl
    || !apiKey
    || !contextWindowTokens
  ) {
    return { issues: Object.freeze(issues) };
  }

  return {
    profile: freezeProfile({
      id,
      label,
      provider,
      ...(sourcePreset ? { sourcePreset } : {}),
      model,
      baseUrl,
      apiKey,
      contextWindowTokens,
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
      ...(structuredOutputMethod ? { structuredOutputMethod } : {}),
      inputModalities,
    }),
    issues: Object.freeze([]),
  };
}

function inferProvider(model: string, baseUrl: string, preset?: LlmModelPreset): string {
  if (preset?.provider) return preset.provider;
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return 'custom';
  }
}

export function createModelProfile(input: {
  id: string;
  label: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  contextWindowTokens?: number;
  sourcePreset?: string;
  inputModalities?: readonly ModelInputModality[];
}): ModelProfileV1 {
  const preset = input.sourcePreset
    ? findLlmModelPresetByKey(input.sourcePreset)
    : undefined;
  if (input.sourcePreset && !preset) {
    throw new ModelProfileConfigError(
      `Unknown model preset "${input.sourcePreset}"`,
      { profileId: input.id },
    );
  }
  const result = parseModelProfile({
    id: input.id,
    label: input.label,
    provider: inferProvider(input.model, input.baseUrl, preset),
    ...(preset ? { sourcePreset: preset.key } : {}),
    model: input.model,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    contextWindowTokens: input.contextWindowTokens
      ?? preset?.contextWindowTokens
      ?? inferLlmContextWindowTokens(input.model)
      ?? 32000,
    ...(preset?.maxOutputTokens ? { maxOutputTokens: preset.maxOutputTokens } : {}),
    ...(preset?.structuredOutputMethod
      ? { structuredOutputMethod: preset.structuredOutputMethod }
      : {}),
    inputModalities: input.inputModalities
      ?? preset?.inputModalities
      ?? ['text'],
  });
  if (!result.profile) {
    throw new ModelProfileConfigError(
      `Cannot construct model profile "${input.id}": ${result.issues.map((issue) => issue.message).join('; ')}`,
      { profileId: input.id, issues: result.issues },
    );
  }
  return result.profile;
}

function buildLegacyProfile(stored: StoredConfig): ModelProfileV1 | undefined {
  const apiKey = stored.llm_api_key?.trim();
  if (!apiKey) return undefined;
  const requestedPreset = findLlmModelPresetByKey(stored.llm_model_preset);
  const model = stored.llm_model?.trim() || requestedPreset?.model || 'deepseek-v4-pro';
  const modelPreset = inferLlmModelPreset(model);
  const inferredPreset = requestedPreset && (
    !stored.llm_model?.trim()
    || modelPreset?.key === requestedPreset.key
  )
    ? requestedPreset
    : modelPreset;
  const baseUrl = stored.llm_base_url?.trim()
    || inferredPreset?.baseUrl
    || (stored.llm_model_preset ? '' : 'https://api.deepseek.com');
  if (!baseUrl) {
    throw new ModelProfileConfigError(
      `Legacy model preset "${stored.llm_model_preset}" requires llm_base_url`,
      { profileId: LEGACY_DEFAULT_MODEL_PROFILE_ID },
    );
  }
  return createModelProfile({
    id: LEGACY_DEFAULT_MODEL_PROFILE_ID,
    label: inferredPreset?.label ?? model,
    sourcePreset: inferredPreset?.key,
    apiKey,
    baseUrl,
    model,
    contextWindowTokens: stored.llm_context_window_tokens,
  });
}

function buildEnvironmentProfile(env: EnvMap): {
  profile?: ModelProfileV1;
  issues?: readonly ModelProfileIssue[];
} {
  const apiKey = env.LLM_API_KEY?.trim() ?? '';
  const baseUrl = env.LLM_BASE_URL?.trim() ?? '';
  const model = env.LLM_MODEL?.trim() ?? '';
  const presentCount = [apiKey, baseUrl, model].filter(Boolean).length;
  if (presentCount === 0) return {};
  if (presentCount !== 3) {
    return {
      issues: Object.freeze([{
        code: 'incomplete_environment_profile',
        message: 'LLM_API_KEY, LLM_BASE_URL, and LLM_MODEL must be set together; partial environment overrides are ignored',
      }]),
    };
  }

  const contextWindowRaw = env.LLM_CONTEXT_WINDOW_TOKENS?.trim();
  const contextWindowTokens = contextWindowRaw ? Number(contextWindowRaw) : undefined;
  const requestedPreset = findLlmModelPresetByKey(env.LLM_MODEL_PRESET);
  const modelPreset = inferLlmModelPreset(model);
  const preset = requestedPreset?.key === modelPreset?.key
    ? requestedPreset
    : modelPreset;
  try {
    return {
      profile: createModelProfile({
        id: ENV_MODEL_PROFILE_ID,
        label: preset ? `${preset.label} (environment)` : `${model} (environment)`,
        sourcePreset: preset?.key,
        apiKey,
        baseUrl,
        model,
        contextWindowTokens,
      }),
    };
  } catch (error) {
    const issues = error instanceof ModelProfileConfigError && error.issues.length > 0
      ? error.issues
      : Object.freeze([{
          code: 'invalid_profile' as const,
          message: error instanceof Error ? error.message : String(error),
        }]);
    return { issues };
  }
}

function parseStoredProfiles(
  value: unknown,
): {
  defaultProfileId?: string;
  profiles: Record<string, ModelProfileV1>;
  unavailableProfiles: Record<string, readonly ModelProfileIssue[]>;
} {
  if (!isRecord(value)) {
    throw new ModelProfileConfigError('models must be an object');
  }
  if (value.version !== MODEL_PROFILES_VERSION) {
    throw new ModelProfileConfigError(`Unsupported models version ${JSON.stringify(value.version)}`);
  }
  if (typeof value.defaultProfileId !== 'string' || !value.defaultProfileId.trim()) {
    throw new ModelProfileConfigError('models.defaultProfileId must be a non-empty string');
  }
  if (value.defaultProfileId.trim() === ENV_MODEL_PROFILE_ID) {
    throw new ModelProfileConfigError(
      `models.defaultProfileId cannot use reserved profile id "${ENV_MODEL_PROFILE_ID}"`,
      { profileId: ENV_MODEL_PROFILE_ID },
    );
  }
  if (!isRecord(value.profiles)) {
    throw new ModelProfileConfigError('models.profiles must be an object');
  }

  const profiles = createDictionary<ModelProfileV1>();
  const unavailableProfiles = createDictionary<readonly ModelProfileIssue[]>();
  for (const [profileId, rawProfile] of Object.entries(value.profiles)) {
    if (profileId === ENV_MODEL_PROFILE_ID) {
      unavailableProfiles[profileId] = Object.freeze([{
        code: 'reserved_profile_id',
        message: `profile id "${ENV_MODEL_PROFILE_ID}" is reserved for environment configuration`,
      }]);
      continue;
    }
    const parsed = parseModelProfile(rawProfile, profileId);
    if (parsed.profile) {
      profiles[profileId] = parsed.profile;
    } else {
      unavailableProfiles[profileId] = parsed.issues;
    }
  }
  return {
    defaultProfileId: value.defaultProfileId.trim(),
    profiles,
    unavailableProfiles,
  };
}

export function buildModelProfileRegistry(options: {
  stored: StoredConfig;
  env?: EnvMap;
}): ModelProfileRegistrySnapshot {
  const env = options.env ?? process.env;
  const storedResult = options.stored.models === undefined
    ? {
        defaultProfileId: undefined,
        profiles: createDictionary<ModelProfileV1>(),
        unavailableProfiles: createDictionary<readonly ModelProfileIssue[]>(),
      }
    : parseStoredProfiles(options.stored.models);

  if (options.stored.models === undefined) {
    const legacyProfile = buildLegacyProfile(options.stored);
    if (legacyProfile) {
      storedResult.profiles[legacyProfile.id] = legacyProfile;
      storedResult.defaultProfileId = legacyProfile.id;
    }
  }

  const environment = buildEnvironmentProfile(env);
  if (environment.profile) {
    storedResult.profiles[environment.profile.id] = environment.profile;
    delete storedResult.unavailableProfiles[environment.profile.id];
  } else if (environment.issues) {
    storedResult.unavailableProfiles[ENV_MODEL_PROFILE_ID] = environment.issues;
  }

  const configuredDefaultProfileId = storedResult.defaultProfileId
    ?? (environment.profile || environment.issues ? ENV_MODEL_PROFILE_ID : '');
  const selectedProfileId = env.PINPAWO_MODEL_PROFILE?.trim()
    || (environment.profile ? ENV_MODEL_PROFILE_ID : configuredDefaultProfileId);

  if (!configuredDefaultProfileId) {
    throw new ModelProfileConfigError(
      'No model profile is configured. Run "pinpawo login" or configure a complete LLM_API_KEY + LLM_BASE_URL + LLM_MODEL tuple.',
    );
  }

  const defaultIssues = readOwnValue(
    storedResult.unavailableProfiles,
    configuredDefaultProfileId,
  );
  if (!readOwnValue(storedResult.profiles, configuredDefaultProfileId)) {
    throw new ModelProfileConfigError(
      defaultIssues
        ? `Default model profile "${configuredDefaultProfileId}" is invalid: ${defaultIssues.map((issue) => issue.message).join('; ')}`
        : `Default model profile "${configuredDefaultProfileId}" does not exist`,
      {
        profileId: configuredDefaultProfileId,
        issues: defaultIssues,
      },
    );
  }

  const selectedIssues = readOwnValue(
    storedResult.unavailableProfiles,
    selectedProfileId,
  );
  if (!readOwnValue(storedResult.profiles, selectedProfileId)) {
    throw new ModelProfileConfigError(
      selectedIssues
        ? `Selected model profile "${selectedProfileId}" is invalid: ${selectedIssues.map((issue) => issue.message).join('; ')}`
        : `Selected model profile "${selectedProfileId}" does not exist`,
      {
        profileId: selectedProfileId,
        issues: selectedIssues,
      },
    );
  }

  return Object.freeze({
    version: MODEL_PROFILES_VERSION,
    defaultProfileId: configuredDefaultProfileId,
    selectedProfileId,
    profiles: Object.freeze({ ...storedResult.profiles }),
    unavailableProfiles: Object.freeze({ ...storedResult.unavailableProfiles }),
  });
}

export function resolveModelProfile(
  registry: ModelProfileRegistrySnapshot,
  profileId: string = registry.selectedProfileId,
): ModelProfileV1 {
  const profile = readOwnValue(registry.profiles, profileId);
  if (profile) return profile;
  const issues = readOwnValue(registry.unavailableProfiles, profileId);
  throw new ModelProfileConfigError(
    issues
      ? `Model profile "${profileId}" is unavailable: ${issues.map((issue) => issue.message).join('; ')}`
      : `Unknown model profile "${profileId}"`,
    { profileId, issues },
  );
}

function sanitizeEndpoint(baseUrl: string): { endpoint: string; endpointHost: string } {
  const url = new URL(baseUrl);
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return {
    endpoint: url.toString().replace(/\/$/, ''),
    endpointHost: url.host,
  };
}

export function summarizeModelProfile(profile: ModelProfileV1): ModelProfileSummary {
  return Object.freeze({
    id: profile.id,
    label: profile.label,
    provider: profile.provider,
    model: profile.model,
    endpointHost: sanitizeEndpoint(profile.baseUrl).endpointHost,
    contextWindowTokens: profile.contextWindowTokens,
    inputModalities: Object.freeze([...effectiveInputModalities(profile)]),
    available: true,
    issues: Object.freeze([]),
  });
}

export function fingerprintModelProfile(profile: ModelProfileV1): ModelProfileFingerprint {
  const preset = profile.sourcePreset
    ? findLlmModelPresetByKey(profile.sourcePreset)
    : undefined;
  const sanitized = {
    provider: profile.provider,
    model: profile.model,
    endpoint: sanitizeEndpoint(profile.baseUrl).endpoint,
    contextWindowTokens: profile.contextWindowTokens,
    maxOutputTokens: profile.maxOutputTokens ?? preset?.maxOutputTokens ?? null,
    structuredOutputMethod: profile.structuredOutputMethod
      ?? inferLlmStructuredOutputMethod(profile.model, profile.baseUrl)
      ?? null,
    inputModalities: [...effectiveInputModalities(profile)].sort(),
  };
  return Object.freeze({
    profileId: profile.id,
    fingerprint: createHash('sha256')
      .update(JSON.stringify(sanitized))
      .digest('hex'),
  });
}

export function removeLegacyModelConfigFields(
  stored: StoredConfig,
): StoredConfig {
  const next = { ...stored };
  delete next.llm_api_key;
  delete next.llm_model_preset;
  delete next.llm_base_url;
  delete next.llm_model;
  delete next.llm_observe_model;
  delete next.llm_context_window_tokens;
  return next;
}

export function writeDefaultModelProfile(
  stored: StoredConfig,
  profile: ModelProfileV1,
): StoredConfig {
  const defaultProfileId = stored.models?.defaultProfileId
    ?? LEGACY_DEFAULT_MODEL_PROFILE_ID;
  if (defaultProfileId === ENV_MODEL_PROFILE_ID || profile.id === ENV_MODEL_PROFILE_ID) {
    throw new ModelProfileConfigError(
      `Profile id "${ENV_MODEL_PROFILE_ID}" is reserved for environment configuration`,
      { profileId: ENV_MODEL_PROFILE_ID },
    );
  }
  if (profile.id !== defaultProfileId) {
    throw new ModelProfileConfigError(
      `Default profile write expected id "${defaultProfileId}", received "${profile.id}"`,
      { profileId: profile.id },
    );
  }
  return {
    ...removeLegacyModelConfigFields(stored),
    models: {
      version: MODEL_PROFILES_VERSION,
      defaultProfileId,
      profiles: {
        ...(stored.models?.profiles ?? {}),
        [defaultProfileId]: profile,
      },
    },
  };
}
