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

export type StudioPluginConfig = {
  id: string;
  options?: Record<string, unknown>;
};

/**
 * 插件数据存在哪里。省略时是 `<workdir>/.pinpawo/studio/studio.sqlite`。
 * SQLite 的 `path` 相对 workdir;Postgres 用 `url`,或用 `urlEnv` 指定
 * 存放连接串的环境变量,避免把密码写进配置文件。
 */
export type StudioStorageSettings =
  | { kind: 'sqlite'; path?: string }
  | { kind: 'postgres'; url: string }
  | { kind: 'postgres'; urlEnv: string };

/**
 * Studio 本地配置——单 workdir 单 studio。
 *
 * Studio 是一块插板:它只声明**可以用哪些 Pet 定义**和**装哪些插件**。Pet 实例
 * 不在配置里,它们是 Studio 数据库里的记录(docs/design/studio/pet-instance.md)。
 * 任务队列、依赖、进度、重试全部属于插件的领域,不出现在这里。
 */
export type StudioLocalConfig = {
  studioId: string;
  name?: string;
  description?: string;

  /** 本 studio 可以创建 Pet 的定义,引用 `PetConfig.definitionId`。 */
  definitions: string[];

  /**
   * 装哪些插件。**必须显式列出** —— studio 不做隐式装配,读一眼配置就知道
   * 这个 studio 由什么驱动。顺序即 start 顺序。
   */
  plugins?: StudioPluginConfig[];

  storage?: StudioStorageSettings;
};

function parseStorage(reader: ConfigReader): StudioStorageSettings | undefined {
  const section = reader.optionalSection('storage');
  if (!section) return undefined;
  const kind = section.requiredString('kind');
  if (kind !== 'sqlite' && kind !== 'postgres') return section.fail('"kind" must be "sqlite" or "postgres"', 'kind');
  const allowed = kind === 'sqlite' ? ['kind', 'path'] : ['kind', 'url', 'urlEnv'];
  for (const field of Object.keys(section.raw)) {
    if (!allowed.includes(field)) section.fail(`"${field}" is not a ${kind} storage setting`, field);
  }
  if (kind === 'sqlite') {
    const path = section.optionalString('path');
    return { kind, ...(path !== undefined ? { path } : {}) };
  }
  const url = section.optionalString('url');
  const urlEnv = section.optionalString('urlEnv');
  if ((url === undefined) === (urlEnv === undefined)) {
    section.fail('postgres storage needs exactly one of "url" and "urlEnv"');
  }
  return url !== undefined ? { kind, url } : { kind, urlEnv: urlEnv! };
}

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

    if (reader.raw.pets !== undefined) {
      reader.fail('"pets" was renamed to "definitions"; Pet instances are created in Studio', 'pets');
    }
    if (reader.raw.entryPetId !== undefined) {
      reader.fail('"entryPetId" was removed; address a Pet by its petId', 'entryPetId');
    }
    const definitions = reader.requiredStringArray('definitions');
    if (definitions.length === 0) {
      reader.fail('"definitions" must not be empty', 'definitions');
    }

    const plugins = parsePluginConfigs(reader);
    const storage = parseStorage(reader);

    return {
      studioId: reader.requiredString('studioId'),
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
      definitions,
      ...(plugins !== undefined ? { plugins } : {}),
      ...(storage !== undefined ? { storage } : {}),
    };
  },
});

/**
 * Resolved studio:每个定义 id 都对应到具体的 PetConfig。
 */
export type ResolvedStudio = {
  studio: StudioLocalConfig;
  /** 按 `studio.definitions` 顺序排列的 Pet 定义 */
  definitions: PetConfig[];
};

/**
 * 把 studio config 跟 Pet 定义列表 join 起来,做结构一致性校验:
 *   1. definitions 数组不能有重复 id
 *   2. 引用的每个定义都必须存在于已加载的 Pet 定义中
 */
export function resolveStudio(
  studio: StudioLocalConfig,
  petConfigs: PetConfig[],
): ResolvedStudio {
  const definitionById = new Map<string, PetConfig>();
  for (const definition of petConfigs) definitionById.set(definition.definitionId, definition);

  const seen = new Set<string>();
  const definitions: PetConfig[] = [];
  for (const definitionId of studio.definitions) {
    if (seen.has(definitionId)) {
      throw new Error(`studio "${studio.studioId}": definitions array has duplicate id "${definitionId}"`);
    }
    seen.add(definitionId);
    const definition = definitionById.get(definitionId);
    if (!definition) {
      throw new Error(
        `studio "${studio.studioId}": definition "${definitionId}" has no matching file in the configured pets directory`,
      );
    }
    definitions.push(definition);
  }

  return { studio, definitions };
}
