import type { BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { z } from 'zod';

export type StructuredOutputMethod = 'functionCalling' | 'jsonMode' | 'jsonSchema';

export type StructuredOutputAutoRepairConfig = boolean | {
  /** Additional retries after the initial structured-output call. Defaults to 1. */
  maxRetries?: number;
};

export type StructuredOutputOptions = {
  name: string;
  method?: StructuredOutputMethod;
  strict?: boolean;
  autoRepair?: StructuredOutputAutoRepairConfig;
};

type StructuredOutputProviderOptions = Omit<StructuredOutputOptions, 'autoRepair'>;

export type StructuredOutputCapableModel = {
  withStructuredOutput: (
    schema: z.ZodTypeAny,
    options: StructuredOutputProviderOptions,
  ) => {
    invoke: (messages: BaseMessage[], options?: RunnableConfig) => Promise<unknown>;
  };
};

/**
 * Extract the major.minor version embedded in a model id and test it against a
 * minimum. Only matches the explicit `<family>X.Y` naming form — model ids that
 * carry a date suffix instead of a version (`kimi-k2-0905`) or no version at all
 * (`kimi-latest`) return false and fall through to the default strategy.
 */
function versionAtLeast(model: string, pattern: RegExp, minMajor: number, minMinor: number): boolean {
  const rawVersion = model.match(pattern)?.[1];
  if (!rawVersion) return false;
  const [majorRaw, minorRaw = '0'] = rawVersion.split('.');
  const major = Number(majorRaw);
  const minor = Number(minorRaw);
  return Number.isFinite(major)
    && Number.isFinite(minor)
    && (major > minMajor || (major === minMajor && minor >= minMinor));
}

function supportsJsonSchemaStructuredOutput(model: string): boolean {
  return versionAtLeast(model, /kimi(?:[-_]?k)?[-_]?(\d+(?:\.\d+)?)/, 2, 6);
}

function supportsJsonModeStructuredOutput(model: string): boolean {
  return model.includes('deepseek')
    || model.includes('qwen')
    || model.includes('glm')
    || model.includes('minimax');
}

function isAliyunCompatibleBaseUrl(baseUrl: string): boolean {
  const normalized = baseUrl.toLowerCase();
  return normalized.includes('dashscope.aliyuncs.com')
    || normalized.includes('maas.aliyuncs.com');
}

/**
 * Pick the structured-output method documented by the upstream model vendor.
 *
 * Kimi 2.6+ supports json_schema; GLM/DeepSeek/Qwen/MiniMax (and unknown models
 * served via an Aliyun-compatible endpoint) use json_mode. Everything else
 * returns undefined so the LangChain default (function calling) applies.
 *
 * This is the single source of truth for the selection strategy — the local
 * agent and the structured-output evals all derive from it so the smoke eval
 * cannot silently drift from production behaviour.
 */
export function inferStructuredOutputMethod(model: string, baseUrl: string): StructuredOutputMethod | undefined {
  const normalizedModel = model.toLowerCase();
  if (supportsJsonSchemaStructuredOutput(normalizedModel)) return 'jsonSchema';
  if (supportsJsonModeStructuredOutput(normalizedModel) || isAliyunCompatibleBaseUrl(baseUrl)) return 'jsonMode';
  return undefined;
}

function resolveAutoRepairMaxRetries(autoRepair: StructuredOutputAutoRepairConfig | undefined): number {
  if (!autoRepair) return 0;
  if (autoRepair === true) return 1;
  const retries = autoRepair.maxRetries ?? 1;
  if (!Number.isFinite(retries) || retries <= 0) return 0;
  return Math.min(Math.floor(retries), 3);
}

function providerOptions(options: StructuredOutputOptions): StructuredOutputProviderOptions {
  return {
    name: options.name,
    ...(options.method ? { method: options.method } : {}),
    ...(typeof options.strict === 'boolean' ? { strict: options.strict } : {}),
  };
}

function compactErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function invokeStructuredOutput<TSchema extends z.ZodTypeAny>(params: {
  model: StructuredOutputCapableModel;
  schema: TSchema;
  options: StructuredOutputOptions;
  messages: BaseMessage[];
  runnableConfig?: RunnableConfig;
}): Promise<z.infer<TSchema>> {
  const maxRetries = resolveAutoRepairMaxRetries(params.options.autoRepair);
  const structuredModel = params.model.withStructuredOutput(
    params.schema,
    providerOptions(params.options),
  );
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const raw = await structuredModel.invoke(params.messages, params.runnableConfig);
      const parsed = params.schema.safeParse(raw);
      if (!parsed.success) {
        throw new Error(`Invalid structured output for ${params.options.name}: ${parsed.error.message}`);
      }
      return parsed.data;
    } catch (error) {
      lastError = error;
      if (attempt >= maxRetries) break;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Structured output failed for ${params.options.name}: ${compactErrorMessage(lastError)}`);
}
