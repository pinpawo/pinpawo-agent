import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import type { PetLocalConfig } from './petConfig';

/**
 * Studio 本地配置——单 host 单 studio,放在 `~/.pinpawo/studio.json`。
 *
 * 设计立场:
 * - 一台主机只有一份 studio 配置(不支持多 studio 共存)。
 * - 通过 plannerPetId / agents 引用 PetLocalConfig.petId,Pet 配置在
 *   `~/.pinpawo/pets/<petId>.json` 单独维护。
 * - capability 可用性检查由 PetAgentRuntime 自行处理,loader 只做结构性
 *   一致性校验(引用存在性、planner 在 agents 中、无重复)。
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
   * - 不填:用 createLLMWikiCurator 自带的 DEFAULT_CURATOR_PROMPT
   * - 填 promptPath:相对本配置文件目录的 prompt 文件,startup 时读一次
   *   动态 prompt 需求请在代码侧用 custom promptProvider override
   */
  curator?: {
    promptPath?: string;
  };

  /** 单 turn 内 dispatch 上限,默认 32 */
  maxIterationCount?: number;
  /** 单 task 的 retry 上限,默认 2 */
  maxRetryPerTask?: number;
};

export const DEFAULT_STUDIO_CONFIG_PATH = path.join(homedir(), '.pinpawo', 'studio.json');

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isOptionalNonEmptyString(value: unknown): value is string | undefined {
  return value === undefined || isNonEmptyString(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isOptionalPositiveInteger(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isInteger(value) && value > 0);
}

/**
 * 严格校验一份 studio config 的形状。
 * 引用一致性(pet 是否存在)由 resolveStudio() 在拿到 pet configs 后再校验。
 */
export function parseStudioLocalConfig(raw: unknown, source: string): StudioLocalConfig {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`studio config at ${source} is not a JSON object`);
  }
  const r = raw as Record<string, unknown>;

  if (!isNonEmptyString(r.studioId)) {
    throw new Error(`studio config ${source}: missing required string "studioId"`);
  }
  if (!isOptionalNonEmptyString(r.name)) {
    throw new Error(`studio config ${source}: "name" must be a non-empty string when present`);
  }
  if (!isOptionalNonEmptyString(r.description)) {
    throw new Error(`studio config ${source}: "description" must be a non-empty string when present`);
  }
  if (!isNonEmptyString(r.plannerPetId)) {
    throw new Error(`studio config ${source}: missing required string "plannerPetId"`);
  }
  if (!isStringArray(r.agents) || r.agents.length === 0) {
    throw new Error(`studio config ${source}: "agents" must be a non-empty string[]`);
  }
  if (!isOptionalPositiveInteger(r.maxIterationCount)) {
    throw new Error(`studio config ${source}: "maxIterationCount" must be a positive integer when present`);
  }
  if (!isOptionalPositiveInteger(r.maxRetryPerTask)) {
    throw new Error(`studio config ${source}: "maxRetryPerTask" must be a positive integer when present`);
  }

  let curator: StudioLocalConfig['curator'];
  if (r.curator !== undefined) {
    const c = r.curator;
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      throw new Error(`studio config ${source}: "curator" must be an object`);
    }
    const cRecord = c as Record<string, unknown>;
    if (!isOptionalNonEmptyString(cRecord.promptPath)) {
      throw new Error(`studio config ${source}: "curator.promptPath" must be a non-empty string when present`);
    }
    curator = cRecord.promptPath !== undefined
      ? { promptPath: cRecord.promptPath as string }
      : {};
  }

  return {
    studioId: r.studioId,
    ...(r.name !== undefined ? { name: r.name as string } : {}),
    ...(r.description !== undefined ? { description: r.description as string } : {}),
    plannerPetId: r.plannerPetId,
    agents: r.agents,
    ...(curator !== undefined ? { curator } : {}),
    ...(r.maxIterationCount !== undefined ? { maxIterationCount: r.maxIterationCount as number } : {}),
    ...(r.maxRetryPerTask !== undefined ? { maxRetryPerTask: r.maxRetryPerTask as number } : {}),
  };
}

/**
 * 从指定路径加载 studio config。
 * - 文件不存在 → 返回 null(caller 自行决定要不要报错)
 * - JSON 无法解析或 schema 不合法 → 抛错
 */
export async function loadStudioLocalConfig(filePath: string = DEFAULT_STUDIO_CONFIG_PATH): Promise<StudioLocalConfig | null> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`studio config ${filePath} is not valid JSON: ${(err as Error).message}`);
  }
  return parseStudioLocalConfig(parsed, filePath);
}

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
 * 把 studio config 跟 pet config 列表 join 起来,做结构一致性校验。
 * 校验项:
 *   1. plannerPetId 必须出现在 agents 数组中
 *   2. agents 数组不能有重复 petId
 *   3. agents 引用的每个 petId 都必须存在于 pets 列表中
 * 任何一项失败 → 抛错。
 */
export function resolveStudio(
  studio: StudioLocalConfig,
  pets: PetLocalConfig[],
): ResolvedStudio {
  const petById = new Map<string, PetLocalConfig>();
  for (const pet of pets) petById.set(pet.petId, pet);

  // 1. agents 不重复
  const seenAgentIds = new Set<string>();
  for (const agentId of studio.agents) {
    if (seenAgentIds.has(agentId)) {
      throw new Error(`studio "${studio.studioId}": agents array has duplicate petId "${agentId}"`);
    }
    seenAgentIds.add(agentId);
  }

  // 2. plannerPetId 在 agents 中
  if (!studio.agents.includes(studio.plannerPetId)) {
    throw new Error(
      `studio "${studio.studioId}": plannerPetId "${studio.plannerPetId}" is not in agents`,
    );
  }

  // 3. 所有 agent 都解析得到
  const resolvedAgents: PetLocalConfig[] = [];
  for (const agentId of studio.agents) {
    const pet = petById.get(agentId);
    if (!pet) {
      throw new Error(
        `studio "${studio.studioId}": agent "${agentId}" has no matching pet config in ~/.pinpawo/pets/`,
      );
    }
    resolvedAgents.push(pet);
  }
  const planner = petById.get(studio.plannerPetId)!;

  return { studio, agents: resolvedAgents, planner };
}
