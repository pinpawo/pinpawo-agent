import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  parseConfigDocument,
  type PetDocument,
} from '@pinpawo/pet-agent';
import { loadPetDocumentFile } from 'pinpawo/host-runtime';
import { petLocalConfigSchema, type PetLocalConfig } from '../configSchema';
import { isSafePetPathSegment } from '../petId';

export type { PetLocalConfig };

export const PET_DOCUMENT_FILE_NAME = 'PET.md';

function resolvePetDirectory(dir: string, petId: string): string {
  if (!isSafePetPathSegment(petId)) {
    throw new Error(`petId "${petId}" must be a safe path segment`);
  }
  const root = path.resolve(dir);
  const petRoot = path.resolve(root, petId);
  const relativePetRoot = path.relative(root, petRoot);
  if (
    relativePetRoot === '..'
    || relativePetRoot.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativePetRoot)
  ) {
    throw new Error(`petId "${petId}" must stay inside the Pet configuration directory`);
  }
  return petRoot;
}

/** Capability collection root derived only from the validated Pet id. */
export function resolvePetCapabilityDirectory(dir: string, petId: string): string {
  return path.join(resolvePetDirectory(dir, petId), 'capabilities');
}

/** Conventional authored root document for one validated Pet id. */
export function resolvePetDocumentPath(dir: string, petId: string): string {
  return path.join(resolvePetDirectory(dir, petId), PET_DOCUMENT_FILE_NAME);
}

/** PET.md is optional; when present it is one immutable Host configuration snapshot. */
export async function loadPetDocument(
  dir: string,
  petId: string,
): Promise<PetDocument | null> {
  return loadPetDocumentFile(resolvePetDocumentPath(dir, petId));
}

/**
 * 文件入口:pet 配置住在 `<workdir>/.pinpawo/pets/<petId>.json`。
 *
 * schema 与校验归 Studio core，解析机制与报错格式归 `@pinpawo/pet-agent`;
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
