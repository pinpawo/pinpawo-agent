import { defineConfigSchema, type ConfigSchema } from '@pinpawo/pet-agent';

/**
 * Studio 的配置 **schema**。
 *
 * 解析机制、字段校验与报错格式由 `@pinpawo/pet-agent` 的 config document
 * 提供;**文件入口**(去哪读、读哪个文件)属于宿主。因此本模块不碰文件系统,
 * 也不假设配置一定来自磁盘。
 */

/**
 * Pet 本地配置。
 *
 * 设计立场:
 * - 本地配置是 source of truth(pet 行为完全由此决定)。
 * - `serverBinding` 仅作为绑定到服务端的 channel key,不放业务字段。
 * - 同一台主机可以有多个 pet 配置共存(Studio 拼装多 pet 时用)。
 * - capability 可用性检查由 PetAgentRuntime 在 invoke 时自行处理,
 *   schema 不负责。
 */
export type PetLocalConfig = {
  petId: string;
  name: string;
  personality?: string;
  species?: string;
  stage?: string;
  /** 一句话角色描述,planner 用来挑 pet */
  role?: string;
  /** 简短服务能力概述,planner 在路由 task → pet 时参考 */
  serviceSummary?: string;
  /** 该 pet 使用的 model profile id;留空则继承 host default profile。 */
  modelProfileId?: string;
  /** 该 pet 允许使用的 capability 名列表 */
  capabilities: string[];
  /** 可选:绑定到服务端 pet,仅用于 app 同步通道,不存业务数据 */
  serverBinding?: {
    petId: string;
  };
};

export const petLocalConfigSchema: ConfigSchema<PetLocalConfig> = defineConfigSchema({
  kind: 'pet config',
  parse: (reader) => {
    const personality = reader.optionalString('personality');
    const species = reader.optionalString('species');
    const stage = reader.optionalString('stage');
    const role = reader.optionalString('role');
    const serviceSummary = reader.optionalString('serviceSummary');
    const modelProfileId = reader.optionalString('modelProfileId');

    // `model` 曾是内联的模型名,已被稳定的 profile id 取代。显式报错,
    // 否则旧配置会被静默忽略、pet 悄悄跑在默认 profile 上。
    if (reader.raw.model !== undefined) {
      reader.fail('"model" was replaced by stable "modelProfileId"', 'model');
    }

    const serverBinding = reader.optionalSection('serverBinding');

    return {
      petId: reader.requiredString('petId'),
      name: reader.requiredString('name'),
      ...(personality !== undefined ? { personality } : {}),
      ...(species !== undefined ? { species } : {}),
      ...(stage !== undefined ? { stage } : {}),
      ...(role !== undefined ? { role } : {}),
      ...(serviceSummary !== undefined ? { serviceSummary } : {}),
      ...(modelProfileId !== undefined ? { modelProfileId } : {}),
      capabilities: reader.raw.capabilities === undefined
        ? []
        : reader.requiredStringArray('capabilities'),
      ...(serverBinding
        ? { serverBinding: { petId: serverBinding.requiredString('petId') } }
        : {}),
    };
  },
});

/**
 * Studio 本地配置——单 workdir 单 studio。
 *
 * 通过 plannerPetId / agents 引用 `PetLocalConfig.petId`;pet 配置单独维护。
 * capability 可用性检查由 PetAgentRuntime 处理,schema 只做结构性校验,
 * 引用一致性由 `resolveStudio()` 在拿到 pet 配置后再校验。
 */
export type StudioLocalConfig = {
  studioId: string;
  name?: string;
  description?: string;

  /** 必须在 agents 数组中 */
  plannerPetId: string;
  /** 引用 PetLocalConfig.petId */
  agents: string[];

  /**
   * 可选:curator prompt 配置。
   * - 不填:用 curator 自带的默认 prompt
   * - 填 promptPath:相对本配置文件目录的 prompt 文件,startup 时读一次
   */
  curator?: {
    promptPath?: string;
  };

  /** 单 turn 内 dispatch 上限,默认 32 */
  maxIterationCount?: number;
  /** 单 task 的 retry 上限,默认 2 */
  maxRetryPerTask?: number;
};

export const studioLocalConfigSchema: ConfigSchema<StudioLocalConfig> = defineConfigSchema({
  kind: 'studio config',
  parse: (reader) => {
    const name = reader.optionalString('name');
    const description = reader.optionalString('description');
    const maxIterationCount = reader.optionalPositiveInteger('maxIterationCount');
    const maxRetryPerTask = reader.optionalPositiveInteger('maxRetryPerTask');

    const agents = reader.requiredStringArray('agents');
    if (agents.length === 0) {
      reader.fail('"agents" must not be empty', 'agents');
    }

    const curatorSection = reader.optionalSection('curator');
    const curatorPromptPath = curatorSection?.optionalString('promptPath');

    return {
      studioId: reader.requiredString('studioId'),
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
      plannerPetId: reader.requiredString('plannerPetId'),
      agents,
      ...(curatorSection
        ? {
            curator: curatorPromptPath !== undefined
              ? { promptPath: curatorPromptPath }
              : {},
          }
        : {}),
      ...(maxIterationCount !== undefined ? { maxIterationCount } : {}),
      ...(maxRetryPerTask !== undefined ? { maxRetryPerTask } : {}),
    };
  },
});

/**
 * Resolved studio:每个 agent 名都对应到具体的 PetLocalConfig。
 */
export type ResolvedStudio = {
  studio: StudioLocalConfig;
  /** 按 studio.agents 顺序排列的 PetLocalConfig */
  agents: PetLocalConfig[];
  /** plannerPetId 对应的 PetLocalConfig(同时也在 agents 数组中) */
  planner: PetLocalConfig;
};

/**
 * 把 studio config 跟 pet config 列表 join 起来,做结构一致性校验:
 *   1. agents 数组不能有重复 petId
 *   2. plannerPetId 必须出现在 agents 数组中
 *   3. agents 引用的每个 petId 都必须存在于 pets 列表中
 */
export function resolveStudio(
  studio: StudioLocalConfig,
  pets: PetLocalConfig[],
): ResolvedStudio {
  const petById = new Map<string, PetLocalConfig>();
  for (const pet of pets) petById.set(pet.petId, pet);

  const seenAgentIds = new Set<string>();
  for (const agentId of studio.agents) {
    if (seenAgentIds.has(agentId)) {
      throw new Error(`studio "${studio.studioId}": agents array has duplicate petId "${agentId}"`);
    }
    seenAgentIds.add(agentId);
  }

  if (!studio.agents.includes(studio.plannerPetId)) {
    throw new Error(
      `studio "${studio.studioId}": plannerPetId "${studio.plannerPetId}" is not in agents`,
    );
  }

  const resolvedAgents: PetLocalConfig[] = [];
  for (const agentId of studio.agents) {
    const pet = petById.get(agentId);
    if (!pet) {
      throw new Error(
        `studio "${studio.studioId}": agent "${agentId}" has no matching pet config in the configured pets directory`,
      );
    }
    resolvedAgents.push(pet);
  }

  return { studio, agents: resolvedAgents, planner: petById.get(studio.plannerPetId)! };
}
