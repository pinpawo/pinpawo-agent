import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import {
  GLOBAL_REVIEW_POLICY_MODE,
  GENERAL_CAPABILITY_NAME,
  stampMessageCreatedAtUtc,
  type AgentCapability,
  type AgentActor,
  type AgentInvokeInput,
  type AgentToolkit,
  type CapabilityArtifactStore,
  type CapabilityRegistryBackend,
  type CompiledAgentRegistry,
  type OrchestratorConfig,
  type ToolkitRuntimeManager,
} from '@pinpawo/pet-agent';
import {
  createCapabilityCreatorCapability,
  createCapabilityCreatorToolkit,
} from './capabilities/capabilityCreator';
import { createExploreCapability } from './capabilities/explore';
import {
  createDailyPostCapability,
  createDailyPostToolkit,
  type DailyImagePlan,
  type DailyPostPayload,
  type TrendPromptItem,
} from './capabilities/dailyPost';
import { createPetProfileToolkit } from './toolkits/petProfile';
import {
  buildLocalAgentModels,
  resolveLlmGenerationReserveTokens,
} from './agentModels';
import type { AgentLlmConfig } from './agentConfig';
import type { AgentContext } from './contextLoader';
import { buildLocalLlmConfig } from './llmConfig';
import { getConfig } from './config';
import { agentStore } from './agentStore';
import { loadStoredConfig } from './storage';
import { buildRuntimeEnvironmentSummary } from './runtimeEnvironment';
import type { LoadedUserCapability } from './capabilityLoader';
import {
  buildLocalAgentInterfaceContext,
  type LocalAgentInterfaceContext,
  type LocalAgentInterfaceKind,
} from './chatInterface';
import {
  inferLlmEntryDecisionProtocol,
  inferLlmStructuredOutputMethod,
} from './llmModelPresets';
import {
  prepareAgentRegistry,
  type CapabilityDiagnosticReporter,
} from './agentRegistryPreparation';

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

function toTrendPromptItems(items: AgentContext['context']['trendItems']): TrendPromptItem[] {
  return items.map((item) => ({
    id: item.id,
    platform: item.platform,
    topic: item.topic ?? null,
    title: item.title,
    summary: item.summary,
    url: item.url ?? null,
    score: item.score,
    likedCount: item.likedCount ?? null,
    imageUrls: item.imageUrls ?? null,
  }));
}

/**
 * Check whether a built-in capability is enabled in config.
 * Returns true if the key is absent (default-on) or explicitly set to true.
 */
function isCapabilityEnabled(id: string): boolean {
  const config = loadStoredConfig();
  const caps = config.capabilities;
  if (!caps || !(id in caps)) return true; // default enabled
  return caps[id] === true;
}

function toRecentDaily(items: AgentContext['context']['recentDaily']) {
  return items.map((item) => ({
    content: item.content,
    topic: item.topic ?? null,
    tags: item.tags ?? null,
    createdAt: item.created_at,
  }));
}

function saveDailyPost(params: {
  actor: AgentActor;
  payload: DailyPostPayload;
  trendItems: TrendPromptItem[];
  selectedTrendId: string | null;
  raw: string;
  attempts: number;
  duplicateRetries: number;
  dryRun?: boolean;
}) {
  return agentStore.savePost({
    candidate: {
      pet_id: params.actor.petId,
      owner_user_id: params.actor.userId,
      name: params.actor.name,
      personality: params.actor.personality,
      stage: params.actor.stage,
      growth_value: null,
      stage_asset_id: null,
      species: params.actor.species,
    },
    payload: {
      ...params.payload,
      image: params.payload.image
        ? ({
            prompt: params.payload.image.prompt,
            negativePrompt: params.payload.image.negativePrompt,
            style: params.payload.image.style,
            shot: params.payload.image.shot,
            seed: params.payload.image.seed,
          } satisfies DailyImagePlan)
        : null,
    },
    trendItems: params.trendItems.map((item) => ({
      id: item.id,
      platform: item.platform,
      topic: item.topic,
      title: item.title,
      summary: item.summary,
      url: item.url ?? null,
      score: item.score,
      liked_count: item.likedCount ?? null,
      image_urls: null,
      cached_image_urls: item.imageUrls,
    })),
    selectedTrendId: params.selectedTrendId,
    raw: params.raw,
    attempts: params.attempts,
    duplicateRetries: params.duplicateRetries,
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

export function buildDecisionStructuredOutput(llmConfig: AgentLlmConfig): OrchestratorConfig['decisionStructuredOutput'] {
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

  const entryDecisionProtocol = method === 'functionCalling'
    ? inferLlmEntryDecisionProtocol(llmConfig.model)
    : 'json';

  return {
    method,
    ...(entryDecisionProtocol === 'routeFunctions' ? { entryDecisionProtocol } : {}),
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
  /** Complete host Toolkit definitions, including currently unavailable instances. */
  toolkitDefinitions?: readonly AgentToolkit[];
  toolkitRuntimeManager?: ToolkitRuntimeManager;
  /** Host-owned diagnostic reporter whose dedupe state follows the host lifecycle. */
  reportCapabilityDiagnostics?: CapabilityDiagnosticReporter;
  /** Stable thread scope required by artifact discovery and checkpoint routing. */
  threadId: string;
  interfaceKind?: LocalAgentInterfaceKind | null;
  dryRun?: boolean;
  checkpoint?: BaseCheckpointSaver;
  /** Host-provided baseline and optional default Capabilities. */
  extraCapabilities?: AgentCapability[];
  /** User-defined capability plugins loaded by capabilityLoader */
  userCapabilities?: LoadedUserCapability[];
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
  const trendItems = toTrendPromptItems(params.context.context.trendItems);
  const sharedToolkits: AgentToolkit[] = [
    createPetProfileToolkit({
      actor,
      profileText: params.context.context.petMemoryText,
    }),
  ];

  const capabilities: AgentCapability[] = [];

  if (isCapabilityEnabled('explore')) {
    appendCapability(capabilities, createExploreCapability());
  }

  if (isCapabilityEnabled('daily_post')) {
    appendCapability(capabilities, createDailyPostCapability());
    sharedToolkits.push(createDailyPostToolkit({
      actor,
      models,
      dryRun: params.dryRun,
      recentDaily: toRecentDaily(params.context.context.recentDaily),
      trendItems,
      savePost: saveDailyPost,
      markUsed: (trendItemId: string, extra?: { sourcePostId?: string }) =>
        agentStore.upsertImpression(actor.petId, trendItemId, 'used', extra),
      markSkipped: (trendItemId: string, reason: string) =>
        agentStore.upsertImpression(actor.petId, trendItemId, 'skipped', { reason }),
      requestImageProcessing: ({ postId }) => agentStore.requestImageProcessing(postId),
    }));
  }

  if (isCapabilityEnabled('capability_creator')) {
    appendCapability(capabilities, createCapabilityCreatorCapability());
    sharedToolkits.push(createCapabilityCreatorToolkit());
  }

  for (const capability of params.extraCapabilities ?? []) {
    appendCapability(capabilities, capability);
  }

  // Append user-defined capabilities (enabled state checked against their manifest id)
  for (const { meta, capability } of params.userCapabilities ?? []) {
    if (!isCapabilityEnabled(meta.id)) continue;
    if (capability.name === GENERAL_CAPABILITY_NAME) {
      throw new Error(
        `Capability name "${GENERAL_CAPABILITY_NAME}" is reserved by the local-agent host`,
      );
    }
    appendCapability(capabilities, capability);
  }
  const baseToolkits = [
    ...sharedToolkits,
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
    params.toolkitDefinitions,
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
      decisionStructuredOutput,
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
      execution: {
        dryRun: params.dryRun,
      },
      workdir: params.workdir,
      runtimeEnvironment: buildRuntimeEnvironmentSummary(params.workdir, {
        sessionStartedAt: params.sessionStartedAt,
        timezone: params.timezone,
      }),
      globalReviewPolicy: {
        mode: llmConfig.globalReviewPolicyMode ?? GLOBAL_REVIEW_POLICY_MODE.REQUIRE_AUTHORIZATION,
        ...(decisionStructuredOutput ? { structuredOutput: decisionStructuredOutput } : {}),
      },
    },
    interfaceContext: buildLocalAgentInterfaceContext({
      threadId: params.threadId,
      kind: params.interfaceKind ?? null,
    }),
  };
}
