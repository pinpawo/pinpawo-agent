import path from 'node:path';
import {
  createLLMWikiCurator,
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
} from '@pinpawo/pet-agent';

import { buildLocalAgentModels } from '../agentModels';
import type { AgentLlmConfig } from '../agentConfig';
import { buildDecisionStructuredOutput } from '../agentChannel';
import { createExploreCapability } from '../capabilities/explore';
import { buildLocalAgentRuntimeConfig } from '../runtimeConfig';
import { DEFAULT_PETS_DIR, loadPetLocalConfigs } from './petConfig';
import {
  DEFAULT_STUDIO_CONFIG_PATH,
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
 * 没有 ~/.pinpawo/studio.json 时抛此错。
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
  /** 全局 LLM config(来自 LocalAgentRuntime.getLlmConfig());pet 没指定 model 时用此 */
  llmConfig: AgentLlmConfig;
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
 * - model(若指定)                             → 该 pet 的 AgentModels 用此 model;
 *                                                 未指定走全局 llmConfig.model
 * - capabilities                                → 按名筛选成 AgentCapability[]
 * - serverBinding                               → MVP 不消费(forward-compat)
 */
export async function buildStudioForTurn(input: BuildStudioInput): Promise<BuildStudioResult> {
  const effectiveWorkdir = input.workdir ?? buildLocalAgentRuntimeConfig().workdir;
  const workdirStateRoot = path.join(effectiveWorkdir, '.pinpawo');
  const preferredStudioConfigPath = input.studioConfigPath
    ?? path.join(workdirStateRoot, 'studio.json');
  let studioConfigPath = preferredStudioConfigPath;
  let studio = await loadStudioLocalConfig(studioConfigPath);
  if (!studio && preferredStudioConfigPath !== DEFAULT_STUDIO_CONFIG_PATH) {
    const legacyStudio = await loadStudioLocalConfig(DEFAULT_STUDIO_CONFIG_PATH);
    if (legacyStudio) {
      console.warn(
        `[studio] using legacy Studio config at ${DEFAULT_STUDIO_CONFIG_PATH}; `
        + `create ${preferredStudioConfigPath} to scope Studio config to the active workdir.`,
      );
      studioConfigPath = DEFAULT_STUDIO_CONFIG_PATH;
      studio = legacyStudio;
    }
  }
  if (!studio) {
    throw new StudioNotConfiguredError(preferredStudioConfigPath);
  }
  const studioConfigDir = path.dirname(studioConfigPath);

  const petsDir = input.petsDir
    ?? (studioConfigPath === DEFAULT_STUDIO_CONFIG_PATH
      ? DEFAULT_PETS_DIR
      : path.join(path.dirname(studioConfigPath), 'pets'));
  const pets = await loadPetLocalConfigs(petsDir);
  const resolved = resolveStudio(studio, pets);

  // curator 用全局 models(不参与 pet 的 model 覆盖)
  const globalModels: AgentModels = buildLocalAgentModels(input.llmConfig);
  // 复用 chat 路径的 decisionStructuredOutput 策略,避免某些 LLM
  // 不支持 json_schema response_format 时 orchestrator decision 调用 400。
  const globalDecisionStructuredOutput = buildDecisionStructuredOutput(input.llmConfig);
  const capabilitiesByName = new Map(input.capabilities.map((c) => [c.name, c]));

  const petAgents: PetAgentRuntime[] = resolved.agents.map((petConfig) => {
    // 每个 pet 按需挑 model:pet 自己声明了就 build pet-级 models + 重算 decisionStructuredOutput
    const petLlmConfig = petConfig.model
      ? { ...input.llmConfig, model: petConfig.model }
      : input.llmConfig;
    const petModels: AgentModels = petConfig.model
      ? buildLocalAgentModels(petLlmConfig)
      : globalModels;
    const petDecisionStructuredOutput = petConfig.model
      ? buildDecisionStructuredOutput(petLlmConfig)
      : globalDecisionStructuredOutput;
    const capsForThisPet: AgentCapability[] = petConfig.capabilities.map((name) => {
      if (name === 'explore') {
        return createExploreCapability({
          structuredOutput: petDecisionStructuredOutput,
        });
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
      capabilities: capsForThisPet,
      toolkits: input.toolkits,
      contextWindowTokens: input.llmConfig.contextWindowTokens,
      decisionStructuredOutput: petDecisionStructuredOutput,
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

  const orchestrator = createStudioOrchestrator({
    studioId: studio.studioId,
    ownerUserId: input.ownerUserId,
    plannerPetId: studio.plannerPetId,
    agents: petAgents,
    wikiBaseDir: input.wikiBaseDir
      ?? path.join(workdirStateRoot, 'studio-wiki'),
    workdir: effectiveWorkdir,
    curator,
    ...(studio.maxIterationCount !== undefined ? { maxIterationCount: studio.maxIterationCount } : {}),
    ...(studio.maxRetryPerTask !== undefined ? { maxRetryPerTask: studio.maxRetryPerTask } : {}),
  });

  return { orchestrator, resolved };
}
