import { HumanMessage } from '@langchain/core/messages';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import {
  petDocumentSystemPromptSection,
  stampAgentMessageCreatedAt,
  type AgentCapability,
  type AgentInvokeInput,
  type AgentToolkit,
  type CapabilityArtifactStore,
  type CompiledAgentRegistry,
  type PetDocument,
  type OrchestratorConfig,
  type OrchestrationDecisionStructuredOutputConfig,
  type ToolkitRuntimeManager,
} from '@pinpawo/pet-agent';
import {
  buildLocalAgentModels,
  resolveLlmGenerationReserveTokens,
} from './agentModels';
import type { AgentLlmConfig } from './agentConfig';
import type { AgentContext } from './contextLoader';
import type { HostExecutionConfig } from './hostExecutionConfig';
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

export type AgentChannelSetup = {
  graphKey: string;
  graphConfig: OrchestratorConfig;
  input: AgentInvokeInput;
  registry: CompiledAgentRegistry;
  /** Host-only attribution; never included in Agent invocation/configurable. */
  traceUserId?: string;
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
  llmConfig: AgentLlmConfig;
  hostConfig: HostExecutionConfig;
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
  /** Fixed session/thread start timestamp used as a stable relative-time anchor. */
  sessionStartedAt?: string;
  /** IANA timezone name for interpreting relative dates in this session. */
  timezone?: string;
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
  const { llmConfig, hostConfig } = params;
  const { capabilityRegistryBackend } = hostConfig;
  const decisionStructuredOutput = buildDecisionStructuredOutput(llmConfig);
  const workdir = hostConfig.runtimeConfig.workdir;
  const models = buildLocalAgentModels(llmConfig);
  const generationReserveTokens = resolveLlmGenerationReserveTokens(llmConfig);
  const capabilities = [...(params.capabilities ?? [])];
  const preparedRegistry = prepareAgentRegistry({
    toolkits: params.toolkits ?? [],
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
      params.context.pet.id,
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
    ]),
    graphConfig: {
      models,
      modelInputModalities: llmConfig.inputModalities ?? ['text'],
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
    traceUserId: params.context.traceUserId,
    input: {
      context: {
        workdir,
        systemPromptSections: [
          ...(params.petDocument ? [petDocumentSystemPromptSection(params.petDocument)] : []),
          {
            id: 'host:runtime-environment',
            owner: 'host',
            content: buildRuntimeEnvironmentSummary({
              sessionStartedAt: params.sessionStartedAt,
              timezone: params.timezone,
            }),
          },
        ],
      },
      messages: [stampAgentMessageCreatedAt(new HumanMessage(params.userMessage))],
      threadId: params.threadId,
      capabilities,
      toolkits: [...preparedRegistry.toolkits],
      globalReviewPolicy: {
        mode: hostConfig.globalReviewPolicyMode,
        safetyLevel: hostConfig.autoAuthorizationSafetyLevel,
        ...(decisionStructuredOutput ? { structuredOutput: decisionStructuredOutput } : {}),
      },
    },
    interfaceContext: buildLocalAgentInterfaceContext({
      threadId: params.threadId,
      kind: params.interfaceKind ?? null,
    }),
  };
}
