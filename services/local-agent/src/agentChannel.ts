import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import {
  type AgentCapability,
  type AgentActor,
  type AgentInvokeInput,
  type AgentToolkit,
  type CapabilityArtifactStore,
  type OrchestratorConfig,
} from '@pinpawo/pet-agent';
import { createCapabilityCreatorCapability } from './capabilities/capabilityCreator';
import { createExploreCapability } from './capabilities/explore';
import {
  createDailyPostCapability,
  type DailyImagePlan,
  type DailyPostPayload,
  type TrendPromptItem,
} from './capabilities/dailyPost';
import { createPetProfileToolkit } from './toolkits/petProfile';
import { buildLocalAgentModels } from './agentModels';
import type { AgentLlmConfig } from './agentConfig';
import type { AgentContext } from './contextLoader';
import { buildLocalLlmConfig } from './llmConfig';
import { agentStore } from './agentStore';
import { loadStoredConfig } from './storage';
import { buildRuntimeEnvironmentSummary } from './runtimeEnvironment';
import type { LoadedUserCapability } from './capabilityLoader';
import {
  buildLocalAgentInterfaceContext,
  type LocalAgentInterfaceContext,
  type LocalAgentInterfaceKind,
} from './chatInterface';
import { inferLlmStructuredOutputMethod } from './llmModelPresets';

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
  const method = inferLlmStructuredOutputMethod(llmConfig.model, llmConfig.baseUrl);
  if (!method) return undefined;

  const autoRepair = llmConfig.structuredOutputAutoRepair
    ? {
        autoRepair: {
          maxRetries: llmConfig.structuredOutputRepairMaxRetries ?? 1,
        },
      }
    : {};

  return { method, ...autoRepair };
}

export function buildLocalChatAgentInput(params: {
  context: AgentContext;
  userMessage: string;
  llmConfig?: AgentLlmConfig;
  toolkits?: AgentToolkit[];
  threadId?: string;
  interfaceKind?: LocalAgentInterfaceKind | null;
  dryRun?: boolean;
  checkpoint?: BaseCheckpointSaver;
  /** Host-provided capabilities implemented by local-agent services */
  extraCapabilities?: AgentCapability[];
  /** User-defined capability plugins loaded by capabilityLoader */
  userCapabilities?: LoadedUserCapability[];
  /** Store handed to capabilities so they can deterministically persist result artifacts */
  capabilityArtifactStore?: CapabilityArtifactStore;
  /** Effective agent workdir for prompt context and relative tool paths. */
  workdir?: string;
}): AgentChannelSetup {
  const llmConfig = params.llmConfig ?? buildLocalLlmConfig();
  const decisionStructuredOutput = buildDecisionStructuredOutput(llmConfig);
  const actor = buildActor(params.context);
  const trendItems = toTrendPromptItems(params.context.context.trendItems);
  const sharedToolkits = [
    createPetProfileToolkit({
      actor,
      profileText: params.context.context.petMemoryText,
    }),
  ];

  const capabilities: AgentCapability[] = [];

  if (isCapabilityEnabled('explore')) {
    appendCapability(capabilities, createExploreCapability({
      structuredOutput: decisionStructuredOutput,
    }));
  }

  if (isCapabilityEnabled('daily_post')) {
    appendCapability(capabilities, createDailyPostCapability({
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
  }

  for (const capability of params.extraCapabilities ?? []) {
    appendCapability(capabilities, capability);
  }

  // Append user-defined capabilities (enabled state checked against their manifest id)
  for (const { meta, capability } of params.userCapabilities ?? []) {
    if (isCapabilityEnabled(meta.id)) appendCapability(capabilities, capability);
  }

  return {
    graphKey: buildGraphKey([
      'local',
      'chat',
      actor.petId,
      llmConfig.model,
      llmConfig.observeModel ?? llmConfig.model,
      String(llmConfig.contextWindowTokens ?? 32000),
      params.checkpoint ? 'checkpoint' : 'memory',
    ]),
    graphConfig: {
      models: buildLocalAgentModels(llmConfig),
      actor,
      checkpoint: params.checkpoint,
      decisionStructuredOutput,
      contextWindowTokens: llmConfig.contextWindowTokens,
      capabilityArtifactStore: params.capabilityArtifactStore,
    },
    input: {
      messages: [
        ...buildHistoryMessages(params.context.context.recentChatTurns),
        new HumanMessage(params.userMessage),
      ],
      threadId: params.threadId,
      capabilities,
      toolkits: [...sharedToolkits, ...(params.toolkits ?? [])],
      execution: {
        dryRun: params.dryRun,
      },
      workdir: params.workdir,
      runtimeEnvironment: buildRuntimeEnvironmentSummary(params.workdir),
    },
    interfaceContext: buildLocalAgentInterfaceContext({
      threadId: params.threadId,
      kind: params.interfaceKind ?? null,
    }),
  };
}
