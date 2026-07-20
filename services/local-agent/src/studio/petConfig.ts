import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Pet 本地配置——用户在 `<workdir>/.pinpawo/pets/<petId>.json` 自行维护。
 *
 * 设计立场:
 * - 本地配置是 source of truth(pet 行为完全由此决定)。
 * - `serverBinding` 仅作为绑定到服务端的 channel key,不放业务字段。
 * - 同一台主机可以有多个 pet 配置共存(Studio 拼装多 pet 时用)。
 * - capability 可用性检查由 PetAgentRuntime 在 invoke 时自行处理,
 *   loader 不负责。
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
  /** 该 pet 用的模型 id,留空则继承全局 llmConfig */
  model?: string;
  /** 该 pet 允许使用的 capability 名列表 */
  capabilities: string[];
  /** 可选:绑定到服务端 pet,仅用于 app 同步通道,不存业务数据 */
  serverBinding?: {
    petId: string;
  };
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isOptionalNonEmptyString(value: unknown): value is string | undefined {
  return value === undefined || isNonEmptyString(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * 严格校验一份 pet config。出错时抛出带具体字段说明的 Error。
 */
export function parsePetLocalConfig(raw: unknown, source: string): PetLocalConfig {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`pet config at ${source} is not a JSON object`);
  }
  const r = raw as Record<string, unknown>;

  if (!isNonEmptyString(r.petId)) {
    throw new Error(`pet config ${source}: missing required string "petId"`);
  }
  if (!isNonEmptyString(r.name)) {
    throw new Error(`pet config ${source}: missing required string "name"`);
  }
  if (!isOptionalNonEmptyString(r.personality)) {
    throw new Error(`pet config ${source}: "personality" must be a non-empty string when present`);
  }
  if (!isOptionalNonEmptyString(r.species)) {
    throw new Error(`pet config ${source}: "species" must be a non-empty string when present`);
  }
  if (!isOptionalNonEmptyString(r.stage)) {
    throw new Error(`pet config ${source}: "stage" must be a non-empty string when present`);
  }
  if (!isOptionalNonEmptyString(r.role)) {
    throw new Error(`pet config ${source}: "role" must be a non-empty string when present`);
  }
  if (!isOptionalNonEmptyString(r.serviceSummary)) {
    throw new Error(`pet config ${source}: "serviceSummary" must be a non-empty string when present`);
  }
  if (!isOptionalNonEmptyString(r.model)) {
    throw new Error(`pet config ${source}: "model" must be a non-empty string when present`);
  }

  const capabilitiesRaw = r.capabilities ?? [];
  if (!isStringArray(capabilitiesRaw)) {
    throw new Error(`pet config ${source}: "capabilities" must be a string[]`);
  }

  let serverBinding: PetLocalConfig['serverBinding'];
  if (r.serverBinding !== undefined) {
    const sb = r.serverBinding;
    if (!sb || typeof sb !== 'object' || Array.isArray(sb)) {
      throw new Error(`pet config ${source}: "serverBinding" must be an object`);
    }
    const sbRecord = sb as Record<string, unknown>;
    if (!isNonEmptyString(sbRecord.petId)) {
      throw new Error(`pet config ${source}: "serverBinding.petId" must be a non-empty string`);
    }
    serverBinding = { petId: sbRecord.petId };
  }

  return {
    petId: r.petId,
    name: r.name,
    ...(r.personality !== undefined ? { personality: r.personality as string } : {}),
    ...(r.species !== undefined ? { species: r.species as string } : {}),
    ...(r.stage !== undefined ? { stage: r.stage as string } : {}),
    ...(r.role !== undefined ? { role: r.role as string } : {}),
    ...(r.serviceSummary !== undefined ? { serviceSummary: r.serviceSummary as string } : {}),
    ...(r.model !== undefined ? { model: r.model as string } : {}),
    capabilities: capabilitiesRaw,
    ...(serverBinding ? { serverBinding } : {}),
  };
}

/**
 * 加载目录里所有 *.json,逐个解析。
 * - 目录不存在或为空 → 返回 []
 * - 单个文件解析失败 → 抛错并附文件路径
 * - 同一 petId 出现两次 → 抛错
 */
export async function loadPetLocalConfigs(dir: string): Promise<PetLocalConfig[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const configs: PetLocalConfig[] = [];
  const seenPetIds = new Set<string>();

  for (const entry of entries.sort()) {
    if (!entry.endsWith('.json')) continue;
    const filePath = path.join(dir, entry);
    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch (err) {
      throw new Error(`failed to read pet config ${filePath}: ${(err as Error).message}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      throw new Error(`pet config ${filePath} is not valid JSON: ${(err as Error).message}`);
    }
    const config = parsePetLocalConfig(parsed, filePath);
    if (seenPetIds.has(config.petId)) {
      throw new Error(`duplicate pet config petId "${config.petId}" (re-defined in ${filePath})`);
    }
    seenPetIds.add(config.petId);
    configs.push(config);
  }

  return configs;
}
