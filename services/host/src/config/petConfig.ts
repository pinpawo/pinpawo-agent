import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  defineConfigSchema,
  parseConfigDocument,
  type ConfigSchema,
  type PetDocument,
} from '@pinpawo/pet-agent';
import { loadPetDocumentFile } from './petDocument';
import { isSafePetPathSegment } from '../petId';

/**
 * 一份 Pet 定义:Pet 怎么工作。Studio 可以用同一份定义创建多个 Pet 实例
 * (docs/design/studio/pet-instance.md);Chat Host 只运行一个 Pet,以定义 id 作它的身份。
 */
export type PetConfig = {
  definitionId: string;
  /** 定义的默认显示名称。 */
  name: string;
  /** 该 pet 使用的 model profile id;留空则继承 host default profile。 */
  modelProfileId?: string;
  /** Agent entry Planner 优先加载的 Capability；留空时使用通用 general。 */
  defaultCapabilityName?: string;
};

export const petConfigSchema: ConfigSchema<PetConfig> = defineConfigSchema({
  kind: 'pet config',
  parse: (reader) => {
    const modelProfileId = reader.optionalString('modelProfileId');
    const defaultCapabilityName = reader.optionalString('defaultCapabilityName');

    // `model` 曾是内联的模型名,已被稳定的 profile id 取代。显式报错,
    // 否则旧配置会被静默忽略、pet 悄悄跑在默认 profile 上。
    if (reader.raw.model !== undefined) {
      reader.fail('"model" was replaced by stable "modelProfileId"', 'model');
    }

    for (const field of ['personality', 'species', 'stage', 'serverBinding']) {
      if (reader.raw[field] !== undefined) {
        reader.fail(field === 'serverBinding'
          ? '"serverBinding" is no longer supported; Pet identity belongs to the local Host'
          : `"${field}" was removed; move authored Pet behavior to PET.md`, field);
      }
    }

    if (reader.raw.petId !== undefined) {
      reader.fail('"petId" was renamed to "definitionId"; Pet instances are created in Studio', 'petId');
    }
    const definitionId = reader.requiredString('definitionId');
    if (!isSafePetPathSegment(definitionId)) {
      reader.fail('"definitionId" must be a safe path segment', 'definitionId');
    }
    if (reader.raw.capabilities !== undefined) {
      reader.fail(
        '"capabilities" was replaced by the conventional pets/<definitionId>/capabilities directory',
        'capabilities',
      );
    }

    return {
      definitionId,
      name: reader.requiredString('name'),
      ...(modelProfileId !== undefined ? { modelProfileId } : {}),
      ...(defaultCapabilityName !== undefined ? { defaultCapabilityName } : {}),
    };
  },
});

/**
 * 一个插件的配置项。
 *
 * `options` 由插件自己解释与校验 —— studio 原样透传,不认识任何插件的
 * 领域概念(设计 §5)。
 */

export const PET_DOCUMENT_FILE_NAME = 'PET.md';

function resolvePetDirectory(dir: string, definitionId: string): string {
  if (!isSafePetPathSegment(definitionId)) {
    throw new Error(`definitionId "${definitionId}" must be a safe path segment`);
  }
  const root = path.resolve(dir);
  const petRoot = path.resolve(root, definitionId);
  const relativePetRoot = path.relative(root, petRoot);
  if (
    relativePetRoot === '..'
    || relativePetRoot.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativePetRoot)
  ) {
    throw new Error(`definitionId "${definitionId}" must stay inside the Pet configuration directory`);
  }
  return petRoot;
}

/** Capability collection root derived only from the validated definition id. */
export function resolvePetCapabilityDirectory(dir: string, definitionId: string): string {
  return path.join(resolvePetDirectory(dir, definitionId), 'capabilities');
}

/** Conventional authored root document for one validated definition id. */
export function resolvePetDocumentPath(dir: string, definitionId: string): string {
  return path.join(resolvePetDirectory(dir, definitionId), PET_DOCUMENT_FILE_NAME);
}

/** PET.md is optional; when present it is one immutable Host configuration snapshot. */
export async function loadPetDocument(
  dir: string,
  definitionId: string,
): Promise<PetDocument | null> {
  return loadPetDocumentFile(resolvePetDocumentPath(dir, definitionId));
}

/**
 * 文件入口:pet 定义住在 `<workdir>/.pinpawo/pets/<definitionId>.json`。
 *
 * schema 与校验归 Studio core，解析机制与报错格式归 `@pinpawo/pet-agent`;
 * 本模块只负责"去哪读、读哪些文件",以及目录级的一致性(definitionId 不重复)。
 */

/**
 * 加载目录里所有 *.json,逐个解析。
 * - 目录不存在或为空 → 返回 []
 * - 单个文件解析失败 → 抛错并附文件路径
 * - 同一 definitionId 出现两次 → 抛错
 */
export async function loadPetConfigs(dir: string): Promise<PetConfig[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const configs: PetConfig[] = [];
  const seenDefinitionIds = new Set<string>();

  for (const entry of entries.sort()) {
    if (!entry.endsWith('.json')) continue;
    const filePath = path.join(dir, entry);
    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch (err) {
      throw new Error(`failed to read pet config ${filePath}: ${(err as Error).message}`);
    }
    const config = parseConfigDocument({
      content,
      source: filePath,
      schema: petConfigSchema,
    });
    if (seenDefinitionIds.has(config.definitionId)) {
      throw new Error(`duplicate pet definitionId "${config.definitionId}" (re-defined in ${filePath})`);
    }
    seenDefinitionIds.add(config.definitionId);
    configs.push(config);
  }

  return configs;
}
