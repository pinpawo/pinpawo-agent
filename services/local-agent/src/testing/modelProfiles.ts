import {
  DEFAULT_TOOL_AUTHORIZATION_SAFETY_LEVEL,
  type ToolAuthorizationSafetyLevel,
} from '@pinpawo/agent-contracts';
import {
  GLOBAL_REVIEW_POLICY_MODE,
  type BuiltinGlobalReviewPolicyMode,
} from '@pinpawo/pet-agent';
import type { AgentLlmConfig } from '../agentConfig';
import type { HostExecutionConfig } from '../hostExecutionConfig';
import { createLocalModelProfileRegistry } from '../llmConfig';
import {
  buildModelProfileRegistry,
  createModelProfile,
  MODEL_PROFILES_VERSION,
  type ModelProfileV1,
} from '../modelProfiles';
import { HostToolkitInventoryStore } from '../toolkits/toolkitInventory';
import type { CapabilityCatalogReader } from '../localServerTypes';
import type { CapabilityCatalogSnapshot } from '../hostCapabilityCatalog';

const emptyCapabilityCatalogSnapshot: CapabilityCatalogSnapshot = Object.freeze({
  capabilities: Object.freeze([]),
});

const emptyCapabilityCatalog: CapabilityCatalogReader = {
  getSnapshot: () => emptyCapabilityCatalogSnapshot,
};

export type TestModelProfileInput = Partial<AgentLlmConfig> & {
  modelProfileId: string;
  label?: string;
};

export function createTestModelProfiles(
  input: Partial<AgentLlmConfig> = {},
) {
  const profile = createModelProfile({
    id: input.modelProfileId ?? 'test-profile',
    label: 'Test profile',
    apiKey: input.apiKey ?? 'test-key',
    baseUrl: input.baseUrl ?? 'https://models.example.test/v1',
    model: input.model ?? 'test-model',
    contextWindowTokens: input.contextWindowTokens ?? 32_000,
    inputModalities: input.inputModalities ?? ['text'],
  });
  const snapshot = buildModelProfileRegistry({
    stored: {
      models: {
        version: MODEL_PROFILES_VERSION,
        defaultProfileId: profile.id,
        profiles: {
          [profile.id]: {
            ...profile,
            ...(input.structuredOutputMethod
              ? { structuredOutputMethod: input.structuredOutputMethod }
              : {}),
            ...(input.maxOutputTokens
              ? { maxOutputTokens: input.maxOutputTokens }
              : {}),
          },
        },
      },
    },
    env: {},
  });
  return createLocalModelProfileRegistry({
    snapshot,
    llmDefaults: {
      ...(input.subagentContextWindowTokens
        ? { subagentContextWindowTokens: input.subagentContextWindowTokens }
        : {}),
      ...(input.temperature !== undefined
        ? { temperature: input.temperature }
        : {}),
      ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.maxRetries !== undefined ? { maxRetries: input.maxRetries } : {}),
      ...(input.verbose !== undefined ? { verbose: input.verbose } : {}),
      ...(input.subagentThinking !== undefined
        ? { subagentThinking: input.subagentThinking }
        : {}),
      ...(input.structuredOutputAutoRepair !== undefined
        ? { structuredOutputAutoRepair: input.structuredOutputAutoRepair }
        : {}),
      ...(input.structuredOutputRepairMaxRetries !== undefined
        ? {
            structuredOutputRepairMaxRetries:
              input.structuredOutputRepairMaxRetries,
          }
        : {}),
    },
  });
}

export function createTestModelProfileRegistry(
  inputs: readonly TestModelProfileInput[],
  defaultProfileId = inputs[0]?.modelProfileId,
) {
  if (!defaultProfileId || inputs.length === 0) {
    throw new Error('test model profile registry requires at least one profile');
  }
  const profiles = Object.fromEntries(inputs.map((input) => {
    const base = createModelProfile({
      id: input.modelProfileId,
      label: input.label ?? input.modelProfileId,
      apiKey: input.apiKey ?? `secret-${input.modelProfileId}`,
      baseUrl: input.baseUrl
        ?? `https://${input.modelProfileId}.models.example.test/v1`,
      model: input.model ?? `${input.modelProfileId}-model`,
      contextWindowTokens: input.contextWindowTokens ?? 32_000,
      inputModalities: input.inputModalities ?? ['text'],
    });
    const profile: ModelProfileV1 = {
      ...base,
      ...(input.structuredOutputMethod
        ? { structuredOutputMethod: input.structuredOutputMethod }
        : {}),
      ...(input.maxOutputTokens
        ? { maxOutputTokens: input.maxOutputTokens }
        : {}),
    };
    return [profile.id, profile];
  }));
  const snapshot = buildModelProfileRegistry({
    stored: {
      models: {
        version: MODEL_PROFILES_VERSION,
        defaultProfileId,
        profiles,
      },
    },
    env: {},
  });
  return createLocalModelProfileRegistry({ snapshot });
}

export function createTestModelServerDeps(
  input: Partial<AgentLlmConfig & HostExecutionConfig> = {},
): {
  modelProfiles: ReturnType<typeof createTestModelProfiles>;
  globalReviewPolicyMode: BuiltinGlobalReviewPolicyMode;
  autoAuthorizationSafetyLevel: ToolAuthorizationSafetyLevel;
  capabilityRegistryBackend: HostExecutionConfig['capabilityRegistryBackend'];
  toolkitInventory: HostToolkitInventoryStore;
  capabilityCatalog: CapabilityCatalogReader;
} {
  return {
    modelProfiles: createTestModelProfiles(input),
    globalReviewPolicyMode: input.globalReviewPolicyMode
      ?? GLOBAL_REVIEW_POLICY_MODE.REQUIRE_AUTHORIZATION,
    autoAuthorizationSafetyLevel: input.autoAuthorizationSafetyLevel
      ?? DEFAULT_TOOL_AUTHORIZATION_SAFETY_LEVEL,
    capabilityRegistryBackend: input.capabilityRegistryBackend ?? 'memory',
    toolkitInventory: new HostToolkitInventoryStore(),
    capabilityCatalog: emptyCapabilityCatalog,
  };
}
