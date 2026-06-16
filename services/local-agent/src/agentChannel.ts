import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import {
  type AgentCapability,
  type AgentActor,
  type AgentInvokeInput,
  type AgentToolkit,
  type OrchestratorConfig,
} from '@pinpawo/pet-agent';
import { createCapabilityCreatorCapability } from './capabilities/capabilityCreator';
import { createExploreCapability } from './capabilities/explore';
import {
  buildDailyPostTaskMessage,
  createDailyPostCapability,
  type DailyImagePlan,
  type DailyPostCapabilityOptions,
  type DailyPostPayload,
  type TrendPromptItem,
} from './capabilities/dailyPost';
import { createPetProfileToolkit } from './toolkits/petProfile';
import { buildLocalAgentModels } from './agentModels';
import type { AgentLlmConfig } from './agentConfig';
import type { AgentContext } from './contextLoader';
import { config } from './config';
import type { CrawlerLogFn } from './crawler';
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

function buildAvoidTopics(items: AgentContext['context']['recentDaily']): string[] {
  return items
    .slice(0, 5)
    .map((item) => item.topic)
    .filter((topic): topic is string => Boolean(topic));
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
  return llmConfig.model.includes('deepseek')
    ? { method: 'functionCalling' }
    : undefined;
}

export function buildLocalChatAgentInput(params: {
  context: AgentContext;
  userMessage: string;
  llmConfig?: AgentLlmConfig;
  toolkits?: AgentToolkit[];
  threadId?: string;
  interfaceKind?: LocalAgentInterfaceKind | null;
  dryRun?: boolean;
  logger?: CrawlerLogFn;
  checkpoint?: BaseCheckpointSaver;
  /** Host-provided capabilities implemented by local-agent services */
  extraCapabilities?: AgentCapability[];
  /** User-defined capability plugins loaded by capabilityLoader */
  userCapabilities?: LoadedUserCapability[];
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
      workdir: config.workdir,
      runtimeEnvironment: buildRuntimeEnvironmentSummary(),
    },
    interfaceContext: buildLocalAgentInterfaceContext({
      threadId: params.threadId,
      kind: params.interfaceKind ?? null,
    }),
  };
}

export function buildLocalScheduledAgentInput(params: {
  context: AgentContext;
  llmConfig?: AgentLlmConfig;
  dryRun?: boolean;
  toolkits?: AgentToolkit[];
  dailyPost?: Partial<
    Pick<
      DailyPostCapabilityOptions,
      'savePost' | 'markUsed' | 'markSkipped' | 'requestImageProcessing'
    >
  >;
  /** User-defined capability plugins loaded by capabilityLoader */
  userCapabilities?: LoadedUserCapability[];
}): AgentChannelSetup {
  const llmConfig = params.llmConfig ?? buildLocalLlmConfig();
  const decisionStructuredOutput = buildDecisionStructuredOutput(llmConfig);
  const actor = buildActor(params.context);
  const trendItems = toTrendPromptItems(params.context.context.trendItems);
  const recentDaily = toRecentDaily(params.context.context.recentDaily);
  const avoidTopics = buildAvoidTopics(params.context.context.recentDaily);
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
      recentDaily,
      trendItems,
      savePost: params.dailyPost?.savePost ?? saveDailyPost,
      markUsed:
        params.dailyPost?.markUsed ??
        ((trendItemId: string, extra?: { sourcePostId?: string }) =>
          agentStore.upsertImpression(actor.petId, trendItemId, 'used', extra)),
      markSkipped:
        params.dailyPost?.markSkipped ??
        ((trendItemId: string, reason: string) =>
          agentStore.upsertImpression(actor.petId, trendItemId, 'skipped', { reason })),
      requestImageProcessing:
        params.dailyPost?.requestImageProcessing ??
        (({ postId }) => agentStore.requestImageProcessing(postId)),
    }));
  }

  // Append user-defined capabilities
  for (const { meta, capability } of params.userCapabilities ?? []) {
    if (isCapabilityEnabled(meta.id)) appendCapability(capabilities, capability);
  }

  return {
    graphKey: buildGraphKey([
      'local',
      'scheduled',
      actor.petId,
      llmConfig.model,
      llmConfig.observeModel ?? llmConfig.model,
      String(llmConfig.contextWindowTokens ?? 32000),
      'memory',
    ]),
    graphConfig: {
      models: buildLocalAgentModels(llmConfig),
      actor,
      decisionStructuredOutput,
      contextWindowTokens: llmConfig.contextWindowTokens,
    },
    input: {
      messages: [
        new HumanMessage(
          buildDailyPostTaskMessage({
            actor,
            petMemoryText: params.context.context.petMemoryText,
            recentDaily,
            trendItems,
            avoidTopics,
            today: params.context.context.today,
          }),
        ),
      ],
      capabilities,
      toolkits: [...sharedToolkits, ...(params.toolkits ?? [])],
      execution: {
        dryRun: params.dryRun,
      },
      workdir: config.workdir,
      runtimeEnvironment: buildRuntimeEnvironmentSummary(),
    },
  };
}
