import type { AgentLlmConfig } from './agentConfig';
import { getConfig } from './config';
import {
  fingerprintModelProfile,
  resolveModelProfile,
  summarizeModelProfile,
  type ModelProfileRegistrySnapshot,
  type ModelProfileSummary,
} from './modelProfiles';
import {
  findLlmModelPresetByKey,
  inferLlmModelPreset,
  type LlmModelPreset,
} from './llmModelPresets';

type ModelIndependentLlmConfig = Omit<
  AgentLlmConfig,
  | 'apiKey'
  | 'baseUrl'
  | 'model'
  | 'modelProfileId'
  | 'modelProfileFingerprint'
  | 'inputModalities'
  | 'structuredOutputMethod'
  | 'maxOutputTokens'
  | 'observeModel'
  | 'contextWindowTokens'
>;

export type LocalModelProfileRegistry = Readonly<{
  snapshot: ModelProfileRegistrySnapshot;
  defaultProfileId: string;
  resolve: (profileId?: string) => Readonly<AgentLlmConfig>;
  listAvailable: () => readonly ModelProfileSummary[];
}>;

function findMatchingSourcePreset(
  profile: ReturnType<typeof resolveModelProfile>,
): LlmModelPreset | undefined {
  if (!profile.sourcePreset) return undefined;
  const preset = findLlmModelPresetByKey(profile.sourcePreset);
  return preset?.key === inferLlmModelPreset(profile.model)?.key
    ? preset
    : undefined;
}

function withPresetCompatibility(
  profile: ReturnType<typeof resolveModelProfile>,
) {
  const preset = findMatchingSourcePreset(profile);
  // Older DeepSeek presets persisted forced function calling. The runtime now
  // uses provider-default thinking, which rejects a named tool_choice.
  const migrateDeepSeekStructuredOutput = preset?.provider === 'deepseek'
    && new URL(profile.baseUrl).hostname === 'api.deepseek.com'
    && profile.structuredOutputMethod === 'functionCalling';
  return preset
    ? {
        ...profile,
        inputModalities: preset.inputModalities,
        ...(migrateDeepSeekStructuredOutput
          ? { structuredOutputMethod: 'jsonMode' as const }
          : {}),
      }
    : profile;
}

function readModelIndependentLlmConfig(): ModelIndependentLlmConfig {
  const config = getConfig();
  return {
    timeoutMs: 120000,
    maxRetries: 2,
    ...(config.structuredOutputAutoRepair !== undefined
      ? { structuredOutputAutoRepair: config.structuredOutputAutoRepair }
      : {}),
    ...(config.structuredOutputRepairMaxRetries !== undefined
      ? { structuredOutputRepairMaxRetries: config.structuredOutputRepairMaxRetries }
      : {}),
  };
}

export function createLocalModelProfileRegistry(options: {
  snapshot: ModelProfileRegistrySnapshot;
  defaultProfileId?: string;
  llmDefaults?: ModelIndependentLlmConfig;
}): LocalModelProfileRegistry {
  const defaultProfileId = options.defaultProfileId
    ?? options.snapshot.selectedProfileId;
  // Validate the configured host default at construction time.
  resolveModelProfile(options.snapshot, defaultProfileId);
  const llmDefaults = Object.freeze({
    ...(options.llmDefaults ?? {}),
  });

  return Object.freeze({
    snapshot: options.snapshot,
    defaultProfileId,
    resolve: (profileId = defaultProfileId) => {
      const profile = resolveModelProfile(options.snapshot, profileId);
      const effectiveProfile = withPresetCompatibility(profile);
      const preset = profile.sourcePreset
        ? findLlmModelPresetByKey(profile.sourcePreset)
        : undefined;
      const maxOutputTokens = profile.maxOutputTokens ?? preset?.maxOutputTokens;
      const fingerprint = fingerprintModelProfile(effectiveProfile).fingerprint;
      return Object.freeze({
        ...llmDefaults,
        apiKey: profile.apiKey,
        baseUrl: profile.baseUrl,
        model: profile.model,
        modelProfileId: profile.id,
        modelProfileFingerprint: fingerprint,
        inputModalities: effectiveProfile.inputModalities,
        ...(effectiveProfile.structuredOutputMethod
          ? { structuredOutputMethod: effectiveProfile.structuredOutputMethod }
          : {}),
        ...(maxOutputTokens
          ? { maxOutputTokens }
          : {}),
        observeModel: profile.model,
        contextWindowTokens: profile.contextWindowTokens,
      });
    },
    listAvailable: () => Object.freeze(
      Object.values(options.snapshot.profiles)
        .map(withPresetCompatibility)
        .map(summarizeModelProfile),
    ),
  });
}

export function buildLocalModelProfileRegistry(): LocalModelProfileRegistry {
  const config = getConfig();
  return createLocalModelProfileRegistry({
    snapshot: config.modelProfileRegistry,
    defaultProfileId: config.modelProfileId,
    llmDefaults: readModelIndependentLlmConfig(),
  });
}

export function buildLocalLlmConfig(overrides: Partial<AgentLlmConfig> = {}): AgentLlmConfig {
  const config = getConfig();
  const registry = buildLocalModelProfileRegistry();
  const resolved = registry.resolve(config.modelProfileId);
  return {
    ...resolved,
    ...overrides,
  };
}

export function resolveLocalModelProfileConfig(
  registry: LocalModelProfileRegistry,
  profileId?: string,
  overrides: Partial<AgentLlmConfig> = {},
): AgentLlmConfig {
  return {
    ...registry.resolve(profileId),
    ...overrides,
  };
}
