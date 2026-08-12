import path from 'node:path';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import {
  GENERAL_CAPABILITY_NAME,
  type AgentCapability,
  type AgentToolkit,
  type AgentModels,
  type ToolkitRuntimeManager,
} from '@pinpawo/pet-agent';
import {
  createStudioOrchestrator,
  type PetAgentRuntime,
  type StudioOrchestrator,
  type StudioRunQueueStore,
} from '@pinpawo/studio';
import { createPetAgentRuntime } from './createPetAgentRuntime';
import {
  createLLMWikiCurator,
  FileStudioRunQueueStore,
  defaultPromptProvider,
  fileReadPromptProvider,
  createFileWikiAccess,
  ensureWikiSkeleton,
  type CuratorPromptProvider,
} from '@pinpawo-toolkit/studio-kanban';

import {
  buildLocalAgentModels,
  resolveLlmGenerationReserveTokens,
} from '../agentModels';
import type { LocalModelProfileRegistry } from '../llmConfig';
import { buildDecisionStructuredOutput } from '../agentChannel';
import { createExploreCapability } from '../capabilities/explore';
import { buildLocalAgentRuntimeConfig } from '../runtimeConfig';
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
  /** local-agent process-owned Toolkit runtime lifecycle. */
  toolkitRuntimeManager?: ToolkitRuntimeManager;
  /**
   * Host 持有的 checkpointer,由所有 pet 共用。缺失时 pet 的 graph 跑在
   * 无 checkpoint 状态,执行进度只存在于内存、中断后无法 resume(#613)。
   */
  checkpoint?: BaseCheckpointSaver;
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
  /**
   * 每个已装配 pet 实际拿到的 checkpointer,按 petId 索引。值为 undefined
   * 表示该 pet 跑在无 checkpoint 状态 —— 执行进度只存在于内存,中断后无法
   * resume(#613)。常驻 host 落地后由 host 持有,这里暴露出来便于确认接线。
   */
  petCheckpointers: ReadonlyMap<string, BaseCheckpointSaver | undefined>;
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
  // Curator remains a structured-output consumer even though Goal Creation and
  // the private Planner no longer use the old orchestrator decision adapter.
  const globalDecisionStructuredOutput = buildDecisionStructuredOutput(globalLlmConfig);
  const capabilitiesByName = new Map(input.capabilities.map((c) => [c.name, c]));
  const generalCapability = capabilitiesByName.get(GENERAL_CAPABILITY_NAME);
  if (!generalCapability) {
    throw new Error(`Studio requires the host baseline Capability "${GENERAL_CAPABILITY_NAME}".`);
  }

  // Studio 的 wiki 是落盘的:把文件实现注入 studio 声明的 port。
  const fileWikiAccess = createFileWikiAccess();

  const petCheckpointers = new Map<string, BaseCheckpointSaver | undefined>();

  const petAgents: PetAgentRuntime[] = resolved.agents.map((petConfig) => {
    // 每个 pet 按稳定 profile id 解析完整 endpoint/key/model 组合。
    const petLlmConfig = petConfig.modelProfileId
      ? input.modelProfiles.resolve(petConfig.modelProfileId)
      : globalLlmConfig;
    const petModels: AgentModels = petConfig.modelProfileId
      ? buildLocalAgentModels(petLlmConfig)
      : globalModels;
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
    const petCheckpoint = input.checkpoint;
    petCheckpointers.set(petConfig.petId, petCheckpoint);
    return createPetAgentRuntime({
      models: petModels,
      wikiAccess: fileWikiAccess,
      modelInputModalities: petLlmConfig.inputModalities ?? ['text'],
      actor: buildPetActorFromLocalConfig(petConfig, input.ownerUserId),
      role: petConfig.role ?? null,
      serviceSummary: petConfig.serviceSummary ?? null,
      capabilities: [
        generalCapability,
        ...capsForThisPet.filter(({ name }) => name !== GENERAL_CAPABILITY_NAME),
      ],
      toolkits: input.toolkits,
      toolkitRuntimeManager: input.toolkitRuntimeManager,
      checkpoint: petCheckpoint,
      contextWindowTokens: petLlmConfig.contextWindowTokens,
      subagentContextWindowTokens: petLlmConfig.subagentContextWindowTokens
        ?? petLlmConfig.contextWindowTokens,
      generationReserveTokens,
      subagentGenerationReserveTokens: generationReserveTokens,
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
    ensureWikiSkeleton,
    ...(studio.maxIterationCount !== undefined ? { maxIterationCount: studio.maxIterationCount } : {}),
    ...(studio.maxRetryPerTask !== undefined ? { maxRetryPerTask: studio.maxRetryPerTask } : {}),
  });

  return { orchestrator, resolved, petCheckpointers };
}
