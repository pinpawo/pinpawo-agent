import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import {
  GLOBAL_REVIEW_POLICY_MODE,
  stampAgentMessageCreatedAt,
  type AgentCapability,
  type AgentInvokeInput,
  type AgentToolkit,
  type CapabilityArtifactStore,
  type CapabilityRegistryBackend,
  type CompiledAgentRegistry,
  type PetDocument,
  type OrchestratorConfig,
  type OrchestrationDecisionStructuredOutputConfig,
  type ToolkitRuntimeManager,
} from '@pinpawo/pet-agent';
import { createPetProfileToolkit } from './toolkits/petProfile';
import {
  buildLocalAgentModels,
  resolveLlmGenerationReserveTokens,
} from './agentModels';
import type { AgentLlmConfig } from './agentConfig';
import type { AgentContext } from './contextLoader';
import { buildLocalLlmConfig } from './llmConfig';
import { getConfig } from './config';
import { buildRuntimeEnvironmentSummary } from './runtimeEnvironment';
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
  /** Already-resolved Capability snapshot supplied by the Host catalog. */
  capabilities?: readonly AgentCapability[];
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
  /** Capability preloaded by the entry Supervisor. */
  defaultCapabilityName?: string;
  /** Canonical PET.md root document applied in Chat and delegated execution. */
  petDocument?: PetDocument;
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
  // These definitions are derived from invocation-local actor or artifact
  // state. They overlay the Host inventory for this compiled run; they are
  // not a second Host Toolkit inventory.
  const invocationToolkits: AgentToolkit[] = [
    createPetProfileToolkit({
      actor,
      profileText: params.context.context.petMemoryText,
    }),
  ];

  const capabilities = [...(params.capabilities ?? [])];
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
      params.defaultCapabilityName ?? 'general',
      params.petDocument?.digest,
    ]),
    graphConfig: {
      models,
      ...(params.petDocument ? { petDocument: params.petDocument } : {}),
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
      ...(params.defaultCapabilityName !== undefined
        ? { defaultCapabilityName: params.defaultCapabilityName }
        : {}),
    },
    registry: preparedRegistry.registry,
    input: {
      messages: [
        ...buildHistoryMessages(params.context.context.recentChatTurns),
        stampAgentMessageCreatedAt(new HumanMessage(params.userMessage)),
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
