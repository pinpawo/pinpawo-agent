import {
  defineConfigSchema,
  type ConfigReader,
  type ConfigSchema,
} from '@pinpawo/pet-agent';
import { isSafePetPathSegment } from './petId';

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
 * - Capability 可用性检查由 local-agent resident runtime 在 dispatch 时处理,
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

    const petId = reader.requiredString('petId');
    if (!isSafePetPathSegment(petId)) {
      reader.fail('"petId" must be a safe path segment', 'petId');
    }
    if (reader.raw.capabilities !== undefined) {
      reader.fail(
        '"capabilities" was replaced by the conventional pets/<petId>/capabilities directory',
        'capabilities',
      );
    }

    return {
      petId,
      name: reader.requiredString('name'),
      ...(personality !== undefined ? { personality } : {}),
      ...(species !== undefined ? { species } : {}),
      ...(stage !== undefined ? { stage } : {}),
      ...(role !== undefined ? { role } : {}),
      ...(serviceSummary !== undefined ? { serviceSummary } : {}),
      ...(modelProfileId !== undefined ? { modelProfileId } : {}),
      ...(serverBinding
        ? { serverBinding: { petId: serverBinding.requiredString('petId') } }
        : {}),
    };
  },
});

/**
 * 一个插件的配置项。
 *
 * `options` 由插件自己解释与校验 —— studio 原样透传,不认识任何插件的
 * 领域概念(设计 §5)。
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

  /** 本 studio 可派活的 pet,引用 `PetLocalConfig.petId`。 */
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
 * Resolved studio:每个 pet 名都对应到具体的 PetLocalConfig。
 */
export type ResolvedStudio = {
  studio: StudioLocalConfig;
  /** 按 `studio.pets` 顺序排列的 PetLocalConfig */
  pets: PetLocalConfig[];
  /** `entryPetId` 对应的 PetLocalConfig(同时也在 pets 中) */
  entryPet: PetLocalConfig;
};

/**
 * 把 studio config 跟 pet config 列表 join 起来,做结构一致性校验:
 *   1. pets 数组不能有重复 petId
 *   2. entryPetId 必须出现在 pets 数组中
 *   3. pets 引用的每个 petId 都必须存在于已加载的 pet 配置中
 */
export function resolveStudio(
  studio: StudioLocalConfig,
  petConfigs: PetLocalConfig[],
): ResolvedStudio {
  const petById = new Map<string, PetLocalConfig>();
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

  const resolvedPets: PetLocalConfig[] = [];
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
