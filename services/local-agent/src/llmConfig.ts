import type { AgentLlmConfig } from './agentConfig';
import { getConfig } from './config';
import {
  fingerprintModelProfile,
  resolveModelProfile,
  summarizeModelProfile,
  type ModelProfileRegistrySnapshot,
  type ModelProfileSummary,
} from './modelProfiles';
import { loadStoredConfig } from './storage';

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

function readModelIndependentLlmConfig(): ModelIndependentLlmConfig {
  const config = getConfig();
  const stored = loadStoredConfig();
  return {
    timeoutMs: 120000,
    maxRetries: 2,
    subagentThinking: stored.subagent_thinking ?? false,
    structuredOutputAutoRepair: config.structuredOutputAutoRepair,
    structuredOutputRepairMaxRetries: config.structuredOutputRepairMaxRetries,
    globalReviewPolicyMode: config.globalReviewPolicyMode,
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
      const fingerprint = fingerprintModelProfile(profile).fingerprint;
      return Object.freeze({
        apiKey: profile.apiKey,
        baseUrl: profile.baseUrl,
        model: profile.model,
        modelProfileId: profile.id,
        modelProfileFingerprint: fingerprint,
        inputModalities: profile.inputModalities,
        ...(profile.structuredOutputMethod
          ? { structuredOutputMethod: profile.structuredOutputMethod }
          : {}),
        ...(profile.maxOutputTokens ? { maxOutputTokens: profile.maxOutputTokens } : {}),
        observeModel: profile.model,
        contextWindowTokens: profile.contextWindowTokens,
        ...llmDefaults,
      });
    },
    listAvailable: () => Object.freeze(
      Object.values(options.snapshot.profiles).map(summarizeModelProfile),
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
