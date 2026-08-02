import path from 'node:path';
import {
  createLLMWikiCurator,
  FileStudioRunQueueStore,
  GENERAL_CAPABILITY_NAME,
  createPetAgentRuntime,
  createStudioOrchestrator,
  defaultPromptProvider,
  fileReadPromptProvider,
  type AgentCapability,
  type AgentToolkit,
  type AgentModels,
  type CuratorPromptProvider,
  type PetAgentRuntime,
  type StudioOrchestrator,
  type StudioRunQueueStore,
} from '@pinpawo/pet-agent';

import {
  buildLocalAgentModels,
  resolveLlmGenerationReserveTokens,
} from '../agentModels';
import type { LocalModelProfileRegistry } from '../llmConfig';
import { buildDecisionStructuredOutput } from '../agentChannel';
import { createExploreCapability } from '../capabilities/explore';
import { loadGeneralCapability } from '../capabilities/general';
import { buildLocalAgentRuntimeConfig } from '../runtimeConfig';
import { inferLlmToolChoiceSupport } from '../llmModelPresets';
import { loadPetLocalConfigs } from './petConfig';
import {
  loadStudioLocalConfig,
  resolveStudio,
  type ResolvedStudio,
} from './studioConfig';
import {
  buildPetActorFromLocalConfig,
  createWsHumanReviewer,
  type PendingReviewSlot,
} from './studioBridge';

/**
 * 当前 workdir 下没有 .pinpawo/studio.json 时抛此错。
 * ws handler 捕获后可以友好提示用户去创建配置。
 */
export class StudioNotConfiguredError extends Error {
  constructor(public readonly configPath: string) {
    super(`No Studio config found at ${configPath}. Create one to enable /studio.`);
    this.name = 'StudioNotConfiguredError';
  }
}

/**
 * 装配时绑定到本次 ws 的 humanReviewer 桥所需的所有上下文。
 * 三件套总是一起出现,所以打包成一个子对象。
 */
export type StudioBridgeContext = {
  send: (msg: unknown) => void;
  requestId: string;
  slot: PendingReviewSlot;
};

export type BuildStudioInput = {
  /** Host-owned model profiles; one profile is resolved per Studio turn/pet. */
  modelProfiles: LocalModelProfileRegistry;
  /** 全局 capability 池(local + user 合并);按 pet config 的 capability 名筛选 */
  capabilities: AgentCapability[];
  /** 全局 toolkit 池(plugin + local);所有 pet 共享 */
  toolkits?: AgentToolkit[];
  /** 当前 local-agent 进程的 owner user id;无服务端绑定时为 null */
  ownerUserId: string | null;
  /** ws 桥三件套:供 humanReviewer 绑定到本次 turn 的 ws 连接 */
  bridge: StudioBridgeContext;
  /** 可选覆盖:studio.json 路径 */
  studioConfigPath?: string;
  /** 可选覆盖:pets 配置目录 */
  petsDir?: string;
  /** 可选覆盖:wiki base 目录 */
  wikiBaseDir?: string;
  /** 当前服务进程的 effective workdir */
  workdir?: string;
};

export type BuildStudioResult = {
  orchestrator: StudioOrchestrator;
  resolved: ResolvedStudio;
};

const runQueueStoresByPath = new Map<string, StudioRunQueueStore>();
const restoredRunQueuePaths = new Set<string>();

function getWorkdirRunQueueStore(filePath: string): {
  store: StudioRunQueueStore;
  shouldRestore: boolean;
} {
  let store = runQueueStoresByPath.get(filePath);
  if (!store) {
    store = new FileStudioRunQueueStore({ filePath });
    runQueueStoresByPath.set(filePath, store);
  }
  const shouldRestore = !restoredRunQueuePaths.has(filePath);
  restoredRunQueuePaths.add(filePath);
  return { store, shouldRestore };
}

/**
 * 加载本地 Studio 配置 + Pet 配置,逐 pet 构造 PetAgentRuntime(humanReviewer 桥到
 * 当前 ws),最终装出 StudioOrchestrator(curator 注入 promptProvider)。
 *
 * 每次 /studio turn 调用一次,fresh build,不 cache。Pet runtime 构造很轻,且
 * 不 cache 让配置改动即生效。
 *
 * - studio.json 不存在 → 抛 StudioNotConfiguredError(handler 自己决定如何提示)
 * - pet config 引用的 capability 不在全局池中 → 抛错(配置错误,启动失败)
 *
 * **pet config 字段消化清单**:
 * - petId / name / personality / species / stage → 合成 AgentActor
 * - role / serviceSummary                       → 传给 createPetAgentRuntime,
 *                                                 planner 选 pet 时通过 availableAgents 看见
 * - modelProfileId(若指定)                    → 该 pet 使用对应 profile;
 *                                                 未指定走 host default profile
 * - capabilities                                → 按名筛选成 AgentCapability[]
 * - serverBinding                               → MVP 不消费(forward-compat)
 */
export async function buildStudioForTurn(input: BuildStudioInput): Promise<BuildStudioResult> {
  const effectiveWorkdir = input.workdir ?? buildLocalAgentRuntimeConfig().workdir;
  const workdirStateRoot = path.join(effectiveWorkdir, '.pinpawo');
  const preferredStudioConfigPath = input.studioConfigPath
    ?? path.join(workdirStateRoot, 'studio.json');
  const studioConfigPath = preferredStudioConfigPath;
  const studio = await loadStudioLocalConfig(studioConfigPath);
  if (!studio) {
    throw new StudioNotConfiguredError(preferredStudioConfigPath);
  }
  const studioConfigDir = path.dirname(studioConfigPath);

  const petsDir = input.petsDir ?? path.join(path.dirname(studioConfigPath), 'pets');
  const pets = await loadPetLocalConfigs(petsDir);
  const resolved = resolveStudio(studio, pets);

  const globalLlmConfig = input.modelProfiles.resolve();
  // curator 用 host default profile(不参与 pet 的 profile 覆盖)
  const globalModels: AgentModels = buildLocalAgentModels(globalLlmConfig);
  // 复用 chat 路径的 decisionStructuredOutput 策略,避免某些 LLM
  // 不支持 json_schema response_format 时 orchestrator decision 调用 400。
  const globalDecisionStructuredOutput = buildDecisionStructuredOutput(globalLlmConfig);
  const capabilitiesByName = new Map(input.capabilities.map((c) => [c.name, c]));
  const generalCapability = loadGeneralCapability();

  const petAgents: PetAgentRuntime[] = resolved.agents.map((petConfig) => {
    // 每个 pet 按稳定 profile id 解析完整 endpoint/key/model 组合。
    const petLlmConfig = petConfig.modelProfileId
      ? input.modelProfiles.resolve(petConfig.modelProfileId)
      : globalLlmConfig;
    const petModels: AgentModels = petConfig.modelProfileId
      ? buildLocalAgentModels(petLlmConfig)
      : globalModels;
    const petDecisionStructuredOutput = petConfig.modelProfileId
      ? buildDecisionStructuredOutput(petLlmConfig)
      : globalDecisionStructuredOutput;
    const generationReserveTokens = resolveLlmGenerationReserveTokens(petLlmConfig);
    const capsForThisPet: AgentCapability[] = petConfig.capabilities.map((name) => {
      if (name === 'explore') {
        return createExploreCapability();
      }
      const cap = capabilitiesByName.get(name);
      if (!cap) {
        throw new Error(
          `pet "${petConfig.petId}" references capability "${name}" which is not registered in this local-agent`,
        );
      }
      return cap;
    });
    return createPetAgentRuntime({
      models: petModels,
      actor: buildPetActorFromLocalConfig(petConfig, input.ownerUserId),
      role: petConfig.role ?? null,
      serviceSummary: petConfig.serviceSummary ?? null,
      capabilities: [
        ...(generalCapability ? [generalCapability] : []),
        ...capsForThisPet.filter(({ name }) => name !== GENERAL_CAPABILITY_NAME),
      ],
      toolkits: input.toolkits,
      contextWindowTokens: petLlmConfig.contextWindowTokens,
      subagentContextWindowTokens: petLlmConfig.subagentContextWindowTokens
        ?? petLlmConfig.contextWindowTokens,
      generationReserveTokens,
      subagentGenerationReserveTokens: generationReserveTokens,
      decisionStructuredOutput: petDecisionStructuredOutput,
      ...(inferLlmToolChoiceSupport(petLlmConfig.model) === 'auto_only'
        ? { capabilityPlannerToolChoice: 'auto' }
        : {}),
      workdir: effectiveWorkdir,
      humanReviewer: createWsHumanReviewer({
        send: input.bridge.send,
        requestId: input.bridge.requestId,
        petId: petConfig.petId,
        slot: input.bridge.slot,
      }),
    });
  });

  const promptProvider: CuratorPromptProvider = studio.curator?.promptPath
    ? fileReadPromptProvider(path.resolve(studioConfigDir, studio.curator.promptPath))
    : defaultPromptProvider();

  const curator = createLLMWikiCurator({
    models: globalModels,
    promptProvider,
    structuredOutput: globalDecisionStructuredOutput,
  });
  const runQueueStorePath = path.join(workdirStateRoot, 'studio-run-queue.json');
  const runQueue = getWorkdirRunQueueStore(runQueueStorePath);

  const orchestrator = createStudioOrchestrator({
    studioId: studio.studioId,
    ownerUserId: input.ownerUserId,
    plannerPetId: studio.plannerPetId,
    agents: petAgents,
    wikiBaseDir: input.wikiBaseDir
      ?? path.join(workdirStateRoot, 'studio-wiki'),
    workdir: effectiveWorkdir,
    runQueueStore: runQueue.store,
    restoreOpenRuns: runQueue.shouldRestore,
    curator,
    ...(studio.maxIterationCount !== undefined ? { maxIterationCount: studio.maxIterationCount } : {}),
    ...(studio.maxRetryPerTask !== undefined ? { maxRetryPerTask: studio.maxRetryPerTask } : {}),
  });

  return { orchestrator, resolved };
}
