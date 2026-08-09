/**
 * Config document 机制 —— 只提供解析、校验与统一报错格式,不碰文件系统。
 *
 * 职责边界(#561):
 * - **本模块**:JSON 解析、字段校验原语、错误信息格式;
 * - **各自的包**:schema 定义(chat 的在宿主,studio 的在 `@pinpawo/studio`);
 * - **各自的宿主**:文件入口 —— 去哪读、读哪个文件。
 *
 * 这样 studio 的 workdir 配置入口可以和 chat 完全不同,但两者的解析行为、
 * 校验语义和报错格式保持一致;chat 也不会被 studio 的配置复杂度污染。
 */

/**
 * 配置错误。带上 `source` 让宿主能指出是哪份文件出的问题,
 * 而不是只抛一个裸字符串。
 */
export class ConfigDocumentError extends Error {
  constructor(
    message: string,
    readonly source: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = 'ConfigDocumentError';
  }
}

/**
 * 读一份配置文档时可用的字段访问器。
 *
 * 每个方法在失败时抛 `ConfigDocumentError`,并自带 `<kind> <source>: ...`
 * 前缀,因此各 schema 不必自己拼错误信息 —— 这正是各处重复的部分。
 */
export type ConfigReader = {
  readonly source: string;
  /** 原始记录,供 schema 处理本机制未覆盖的特殊结构。 */
  readonly raw: Record<string, unknown>;

  requiredString(field: string): string;
  optionalString(field: string): string | undefined;
  requiredStringArray(field: string): string[];
  optionalStringArray(field: string): string[] | undefined;
  optionalPositiveInteger(field: string): number | undefined;
  /** 嵌套对象;缺失时返回 undefined,存在但不是对象则报错。 */
  optionalSection(field: string): ConfigReader | undefined;
  /** 抛出一个带统一前缀的自定义错误,供 schema 表达跨字段约束。 */
  fail(message: string, field?: string): never;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function createReader(
  raw: Record<string, unknown>,
  kind: string,
  source: string,
  path: string,
): ConfigReader {
  const label = path ? `${kind} ${source} (${path})` : `${kind} ${source}`;
  const qualify = (field: string) => (path ? `${path}.${field}` : field);

  function fail(message: string, field?: string): never {
    throw new ConfigDocumentError(
      `${label}: ${message}`,
      source,
      field ? qualify(field) : undefined,
    );
  }

  return {
    source,
    raw,

    requiredString(field) {
      const value = raw[field];
      if (!isNonEmptyString(value)) {
        fail(`missing required string "${field}"`, field);
      }
      return value;
    },

    optionalString(field) {
      const value = raw[field];
      if (value === undefined) return undefined;
      if (!isNonEmptyString(value)) {
        fail(`"${field}" must be a non-empty string when present`, field);
      }
      return value;
    },

    requiredStringArray(field) {
      const value = raw[field];
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        fail(`"${field}" must be a string[]`, field);
      }
      return [...(value as string[])];
    },

    optionalStringArray(field) {
      const value = raw[field];
      if (value === undefined) return undefined;
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        fail(`"${field}" must be a string[] when present`, field);
      }
      return [...(value as string[])];
    },

    optionalPositiveInteger(field) {
      const value = raw[field];
      if (value === undefined) return undefined;
      if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
        fail(`"${field}" must be a positive integer when present`, field);
      }
      return value;
    },

    optionalSection(field) {
      const value = raw[field];
      if (value === undefined) return undefined;
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail(`"${field}" must be an object when present`, field);
      }
      return createReader(
        value as Record<string, unknown>,
        kind,
        source,
        qualify(field),
      );
    },

    fail,
  };
}

export type ConfigSchema<T> = {
  /** 出现在错误信息里的文档类型名,例如 "pet config"。 */
  kind: string;
  parse: (reader: ConfigReader) => T;
};

export function defineConfigSchema<T>(schema: ConfigSchema<T>): ConfigSchema<T> {
  return schema;
}

/**
 * 校验一个**已经解析好**的值。宿主自己拿到对象时用这个。
 */
export function parseConfigValue<T>(
  value: unknown,
  schema: ConfigSchema<T>,
  source: string,
): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigDocumentError(
      `${schema.kind} at ${source} is not a JSON object`,
      source,
    );
  }
  return schema.parse(
    createReader(value as Record<string, unknown>, schema.kind, source, ''),
  );
}

/**
 * 解析一份配置文档的文本内容。
 *
 * `content` 由调用方读出 —— 本模块不碰文件系统,`source` 只用于错误信息。
 */
export function parseConfigDocument<T>(input: {
  content: string;
  source: string;
  schema: ConfigSchema<T>;
}): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.content);
  } catch (error) {
    throw new ConfigDocumentError(
      `${input.schema.kind} ${input.source} is not valid JSON: ${(error as Error).message}`,
      input.source,
    );
  }
  return parseConfigValue(parsed, input.schema, input.source);
}
