import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import {
  GLOBAL_REVIEW_POLICY_MODE,
  GENERAL_CAPABILITY_NAME,
  stampMessageCreatedAtUtc,
  type AgentCapability,
  type AgentInvokeInput,
  type AgentToolkit,
  type CapabilityArtifactStore,
  type CapabilityRegistryBackend,
  type CompiledAgentRegistry,
  type OrchestratorConfig,
  type OrchestrationDecisionStructuredOutputConfig,
  type ToolkitRuntimeManager,
} from '@pinpawo/pet-agent';
import {
  createCapabilityCreatorCapability,
  createCapabilityCreatorToolkit,
} from './capabilities/capabilityCreator';
import { createPetProfileToolkit } from './toolkits/petProfile';
import {
  buildLocalAgentModels,
  resolveLlmGenerationReserveTokens,
} from './agentModels';
import type { AgentLlmConfig } from './agentConfig';
import type { AgentContext } from './contextLoader';
import { buildLocalLlmConfig } from './llmConfig';
import { getConfig } from './config';
import { loadStoredConfig, type StoredConfig } from './storage';
import { buildRuntimeEnvironmentSummary } from './runtimeEnvironment';
import type { LoadedUserCapability } from './capabilityLoader';
import {
  buildLocalAgentInterfaceContext,
  type LocalAgentInterfaceContext,
  type LocalAgentInterfaceKind,
} from './chatInterface';
import {
  inferLlmStructuredOutputMethod,
} from './llmModelPresets';
import {
  prepareAgentRegistry,
  type CapabilityDiagnosticReporter,
} from './agentRegistryPreparation';
import type { ToolkitInventoryEntry } from './toolkits/toolkitInventory';
import { getBuiltInCapabilityMeta } from './capabilityRegistry';
import { resolveCapabilityEnabled } from './capabilityActivation';

function buildActor(context: AgentContext) {
  return {
    petId: context.pet.id,
    userId: null,
    name: context.pet.name,
    personality: context.pet.personality,
    stage: context.pet.stage,
    species: context.pet.species,
  };
}

function buildHistoryMessages(
  turns: Array<{ userMessage: string | null; petMessage: string | null }>,
  maxTurns = 3,
): BaseMessage[] {
  return turns
    .slice(-Math.max(0, maxTurns))
    .flatMap((turn) => {
      const messages: BaseMessage[] = [];
      if (typeof turn.userMessage === 'string' && turn.userMessage.trim()) {
        messages.push(new HumanMessage(turn.userMessage.trim()));
      }
      if (typeof turn.petMessage === 'string' && turn.petMessage.trim()) {
        messages.push(new AIMessage(turn.petMessage.trim()));
      }
      return messages;
    });
}

export type AgentChannelSetup = {
  graphKey: string;
  graphConfig: OrchestratorConfig;
  input: AgentInvokeInput;
  registry: CompiledAgentRegistry;
  interfaceContext?: LocalAgentInterfaceContext;
};

function buildGraphKey(parts: Array<string | null | undefined>) {
  return parts
    .map((part) => (part == null || part === '' ? '_' : part))
    .join(':');
}

function appendCapability(
  capabilities: AgentCapability[],
  capability: AgentCapability,
) {
  if (capabilities.some((item) => item.name === capability.name)) {
    return;
  }
  capabilities.push(capability);
}

export function buildDecisionStructuredOutput(
  llmConfig: AgentLlmConfig,
): OrchestrationDecisionStructuredOutputConfig | undefined {
  const method = llmConfig.structuredOutputMethod
    ?? inferLlmStructuredOutputMethod(llmConfig.model, llmConfig.baseUrl);
  if (!method) return undefined;

  const autoRepairEnabled = llmConfig.structuredOutputAutoRepair
    ?? true;
  const autoRepair = autoRepairEnabled
    ? {
        autoRepair: {
          maxRetries: llmConfig.structuredOutputRepairMaxRetries ?? 1,
        },
      }
    : {};

  return {
    method,
    ...autoRepair,
  };
}

export function buildLocalChatAgentInput(params: {
  context: AgentContext;
  userMessage: string;
  llmConfig?: AgentLlmConfig;
  /** Cache identity for hosts that key a graph to one durable session ledger. */
  sessionContextCacheKey?: string;
  toolkits?: AgentToolkit[];
  /** Complete Host inventory projection, including unavailable Toolkits and reasons. */
  toolkitInventoryEntries?: readonly ToolkitInventoryEntry[];
  toolkitRuntimeManager?: ToolkitRuntimeManager;
  /** Host-owned diagnostic reporter whose dedupe state follows the host lifecycle. */
  reportCapabilityDiagnostics?: CapabilityDiagnosticReporter;
  /** Stable thread scope required by artifact discovery and checkpoint routing. */
  threadId: string;
  interfaceKind?: LocalAgentInterfaceKind | null;
  checkpoint?: BaseCheckpointSaver;
  /** Host-provided baseline and optional default Capabilities. */
  extraCapabilities?: AgentCapability[];
  /** User-defined capability plugins loaded by capabilityLoader */
  userCapabilities?: LoadedUserCapability[];
  /** Stable config snapshot used to select Capability definitions for this run. */
  capabilityConfig?: Pick<StoredConfig, 'capabilities'>;
  /** Store handed to capabilities so they can deterministically persist result artifacts */
  capabilityArtifactStore: CapabilityArtifactStore;
  /** Effective agent workdir for prompt context and relative tool paths. */
  workdir?: string;
  /** Fixed session/thread start timestamp used as a stable relative-time anchor. */
  sessionStartedAt?: string;
  /** IANA timezone name for interpreting relative dates in this session. */
  timezone?: string;
  /** Explicit Capability registry backend. Defaults to local-agent configuration. */
  capabilityRegistryBackend?: CapabilityRegistryBackend;
}): AgentChannelSetup {
  if (!params.threadId.trim()) {
    throw new Error('Local chat requires a non-empty threadId');
  }
  if (!params.capabilityArtifactStore) {
    throw new Error('Local chat requires a capability artifact store');
  }
  const llmConfig = params.llmConfig ?? buildLocalLlmConfig();
  const capabilityRegistryBackend = params.capabilityRegistryBackend
    ?? getConfig().capabilityRegistryBackend;
  const decisionStructuredOutput = buildDecisionStructuredOutput(llmConfig);
  const actor = buildActor(params.context);
  const models = buildLocalAgentModels(llmConfig);
  const generationReserveTokens = resolveLlmGenerationReserveTokens(llmConfig);
  const capabilityConfig = params.capabilityConfig ?? loadStoredConfig();
  // These definitions are derived from invocation-local actor or artifact
  // state. They overlay the Host inventory for this compiled run; they are
  // not a second Host Toolkit inventory.
  const invocationToolkits: AgentToolkit[] = [
    createPetProfileToolkit({
      actor,
      profileText: params.context.context.petMemoryText,
    }),
  ];

  const capabilities: AgentCapability[] = [];

  const capabilityCreatorMeta = getBuiltInCapabilityMeta('capability_creator');
  if (capabilityCreatorMeta && resolveCapabilityEnabled(capabilityCreatorMeta, capabilityConfig)) {
    appendCapability(capabilities, createCapabilityCreatorCapability());
    invocationToolkits.push(createCapabilityCreatorToolkit());
  }

  for (const capability of params.extraCapabilities ?? []) {
    const meta = getBuiltInCapabilityMeta(capability.name);
    if (meta && !resolveCapabilityEnabled(meta, capabilityConfig)) continue;
    appendCapability(capabilities, capability);
  }

  // Append user-defined capabilities (enabled state checked against their manifest id)
  for (const { meta, capability } of params.userCapabilities ?? []) {
    if (!resolveCapabilityEnabled(meta, capabilityConfig)) continue;
    if (capability.name === GENERAL_CAPABILITY_NAME) {
      throw new Error(
        `Capability name "${GENERAL_CAPABILITY_NAME}" is reserved by the local-agent host`,
      );
    }
    appendCapability(capabilities, capability);
  }
  const baseToolkits = [
    ...invocationToolkits,
    ...(params.toolkits ?? []),
  ];
  const preparedRegistry = prepareAgentRegistry({
    toolkits: baseToolkits,
    capabilities,
    threadId: params.threadId,
    capabilityArtifactStore: params.capabilityArtifactStore,
  });
  params.reportCapabilityDiagnostics?.(
    preparedRegistry.registry,
    params.toolkitInventoryEntries,
  );

  return {
    graphKey: buildGraphKey([
      'local',
      'chat',
      actor.petId,
      llmConfig.modelProfileId,
      llmConfig.modelProfileFingerprint,
      params.sessionContextCacheKey,
      llmConfig.model,
      llmConfig.observeModel ?? llmConfig.model,
      String(llmConfig.contextWindowTokens ?? 32000),
      String(llmConfig.subagentContextWindowTokens ?? llmConfig.contextWindowTokens ?? 32000),
      String(generationReserveTokens ?? 0),
      params.checkpoint ? 'checkpoint' : 'memory',
      capabilityRegistryBackend,
    ]),
    graphConfig: {
      models,
      modelInputModalities: llmConfig.inputModalities ?? ['text'],
      actor,
      checkpoint: params.checkpoint,
      contextWindowTokens: llmConfig.contextWindowTokens,
      subagentContextWindowTokens: llmConfig.subagentContextWindowTokens ?? llmConfig.contextWindowTokens,
      generationReserveTokens,
      subagentGenerationReserveTokens: generationReserveTokens,
      capabilityArtifactStore: params.capabilityArtifactStore,
      toolkitRuntimeManager: params.toolkitRuntimeManager,
      capabilityRegistryBackend,
    },
    registry: preparedRegistry.registry,
    input: {
      messages: [
        ...buildHistoryMessages(params.context.context.recentChatTurns),
        stampMessageCreatedAtUtc(new HumanMessage(params.userMessage)),
      ],
      threadId: params.threadId,
      capabilities,
      toolkits: [...preparedRegistry.toolkits],
      workdir: params.workdir,
      runtimeEnvironment: buildRuntimeEnvironmentSummary(params.workdir, {
        sessionStartedAt: params.sessionStartedAt,
        timezone: params.timezone,
      }),
      globalReviewPolicy: {
        mode: llmConfig.globalReviewPolicyMode ?? GLOBAL_REVIEW_POLICY_MODE.REQUIRE_AUTHORIZATION,
        ...(llmConfig.autoAuthorizationSafetyLevel ? {
          safetyLevel: llmConfig.autoAuthorizationSafetyLevel,
        } : {}),
        ...(decisionStructuredOutput ? { structuredOutput: decisionStructuredOutput } : {}),
      },
    },
    interfaceContext: buildLocalAgentInterfaceContext({
      threadId: params.threadId,
      kind: params.interfaceKind ?? null,
    }),
  };
}
