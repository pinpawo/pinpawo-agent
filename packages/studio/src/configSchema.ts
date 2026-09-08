import type { PetConfig } from 'pinpawo/host-runtime';
import {
  defineConfigSchema,
  type ConfigReader,
  type ConfigSchema,
} from '@pinpawo/pet-agent';

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
 * - 本地配置声明 Host 身份与路由；行为与人设由 PET.md 定义。
 * - 同一台主机可以有多个 pet 配置共存(Studio 拼装多 pet 时用)。
 * - schema 只解析默认 Capability 名称；Studio Host composition 在 resident 启动前
 *   对已加载的 Pet Capability 做 fail-fast 可用性检查。
 */
export type StudioPluginConfig = {
  id: string;
  options?: Record<string, unknown>;
};

/**
 * Studio 本地配置——单 workdir 单 studio。
 *
 * Studio 是一块插板:它只声明**有哪些 pet**、**装哪些插件**、以及外部
 * 入口派给谁。任务队列、依赖、进度、重试全部属于插件的领域,不出现在
 * 这里。
 */
export type StudioLocalConfig = {
  studioId: string;
  name?: string;
  description?: string;

  /**
   * 外部输入默认派给哪个 pet。宿主经 `dispatch({ petId: entryPetId, ... })` 使用。
   *
   * 它就是一次普通 dispatch —— 该 pet 只是恰好扮演拆解角色,studio 不认识
   * "planner"这个概念,因此字段名不叫 plannerPetId。必须在 `pets` 中。
   */
  entryPetId: string;

  /** 本 studio 可派活的 pet,引用 `PetConfig.petId`。 */
  pets: string[];

  /**
   * 装哪些插件。**必须显式列出** —— studio 不做隐式装配,读一眼配置就知道
   * 这个 studio 由什么驱动。顺序即 start 顺序。
   */
  plugins?: StudioPluginConfig[];
};

function parsePluginConfigs(reader: ConfigReader): StudioPluginConfig[] | undefined {
  const raw = reader.raw.plugins;
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    reader.fail('"plugins" must be an array when present', 'plugins');
  }
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      reader.fail(`"plugins[${index}]" must be an object`, `plugins[${index}]`);
    }
    const record = entry as Record<string, unknown>;
    const id = record.id;
    if (typeof id !== 'string' || id.length === 0) {
      reader.fail(`"plugins[${index}].id" must be a non-empty string`, `plugins[${index}].id`);
    }
    const options = record.options;
    if (options !== undefined
      && (!options || typeof options !== 'object' || Array.isArray(options))) {
      reader.fail(
        `"plugins[${index}].options" must be an object when present`,
        `plugins[${index}].options`,
      );
    }
    return {
      id,
      // options 原样透传:studio 不解释,校验归插件自己的 schema。
      ...(options !== undefined ? { options: options as Record<string, unknown> } : {}),
    };
  });
}

export const studioLocalConfigSchema: ConfigSchema<StudioLocalConfig> = defineConfigSchema({
  kind: 'studio config',
  parse: (reader) => {
    const name = reader.optionalString('name');
    const description = reader.optionalString('description');

    const pets = reader.requiredStringArray('pets');
    if (pets.length === 0) {
      reader.fail('"pets" must not be empty', 'pets');
    }

    const plugins = parsePluginConfigs(reader);

    return {
      studioId: reader.requiredString('studioId'),
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
      entryPetId: reader.requiredString('entryPetId'),
      pets,
      ...(plugins !== undefined ? { plugins } : {}),
    };
  },
});

/**
 * Resolved studio:每个 pet 名都对应到具体的 PetConfig。
 */
export type ResolvedStudio = {
  studio: StudioLocalConfig;
  /** 按 `studio.pets` 顺序排列的 PetConfig */
  pets: PetConfig[];
  /** `entryPetId` 对应的 PetConfig(同时也在 pets 中) */
  entryPet: PetConfig;
};

/**
 * 把 studio config 跟 pet config 列表 join 起来,做结构一致性校验:
 *   1. pets 数组不能有重复 petId
 *   2. entryPetId 必须出现在 pets 数组中
 *   3. pets 引用的每个 petId 都必须存在于已加载的 pet 配置中
 */
export function resolveStudio(
  studio: StudioLocalConfig,
  petConfigs: PetConfig[],
): ResolvedStudio {
  const petById = new Map<string, PetConfig>();
  for (const pet of petConfigs) petById.set(pet.petId, pet);

  const seen = new Set<string>();
  for (const petId of studio.pets) {
    if (seen.has(petId)) {
      throw new Error(`studio "${studio.studioId}": pets array has duplicate petId "${petId}"`);
    }
    seen.add(petId);
  }

  if (!studio.pets.includes(studio.entryPetId)) {
    throw new Error(
      `studio "${studio.studioId}": entryPetId "${studio.entryPetId}" is not in pets`,
    );
  }

  const resolvedPets: PetConfig[] = [];
  for (const petId of studio.pets) {
    const pet = petById.get(petId);
    if (!pet) {
      throw new Error(
        `studio "${studio.studioId}": pet "${petId}" has no matching pet config in the configured pets directory`,
      );
    }
    resolvedPets.push(pet);
  }

  return { studio, pets: resolvedPets, entryPet: petById.get(studio.entryPetId)! };
}
