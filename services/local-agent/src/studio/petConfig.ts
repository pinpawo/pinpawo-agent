import { promises as fs } from 'node:fs';
import path from 'node:path';

import { parseConfigDocument } from '@pinpawo/pet-agent';
import { petLocalConfigSchema, type PetLocalConfig } from '@pinpawo/studio';

export type { PetLocalConfig };

/**
 * 文件入口:pet 配置住在 `<workdir>/.pinpawo/pets/<petId>.json`。
 *
 * schema 与校验归 `@pinpawo/studio`,解析机制与报错格式归 `@pinpawo/pet-agent`;
 * 本模块只负责"去哪读、读哪些文件",以及目录级的一致性(petId 不重复)。
 */

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
    const config = parseConfigDocument({
      content,
      source: filePath,
      schema: petLocalConfigSchema,
    });
    if (seenPetIds.has(config.petId)) {
      throw new Error(`duplicate pet config petId "${config.petId}" (re-defined in ${filePath})`);
    }
    seenPetIds.add(config.petId);
    configs.push(config);
  }

  return configs;
}
