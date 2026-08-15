import type { StructuredOutputMethod } from '@pinpawo/pet-agent';
import type { ModelInputModality } from './modelProfiles';

export type LlmThinkingControl =
  | 'extra_body_enable_thinking'
  | 'thinking_type'
  | 'always_enabled'
  | 'none';

export type LlmRuntimeRole = 'act' | 'decision' | 'answer' | 'observe' | 'subagent';
export type LlmReasoningEffort = 'low' | 'medium' | 'xhigh';

export type LlmModelPreset = {
  key: string;
  label: string;
  provider: string;
  model: string;
  baseUrl?: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  structuredOutputMethod?: StructuredOutputMethod;
  /**
   * Inputs accepted by the model API represented by this preset.
   *
   * This is explicit capability metadata. Runtime code must never infer image
   * support from a model name.
   */
  inputModalities: readonly ModelInputModality[];
  thinkingControl?: LlmThinkingControl;
  requiresStreaming?: boolean;
  aliases: readonly string[];
  officialDocs: readonly string[];
};

export const LLM_MODEL_PRESETS: readonly LlmModelPreset[] = [
  {
    key: 'gpt-5',
    label: 'OpenAI GPT-5.5',
    provider: 'openai',
    model: 'gpt-5.5',
    baseUrl: 'https://api.openai.com/v1',
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 128_000,
    structuredOutputMethod: 'jsonSchema',
    inputModalities: ['text', 'image'],
    thinkingControl: 'none',
    aliases: [
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.3',
    ],
    officialDocs: [
      'https://developers.openai.com/api/docs/models',
      'https://developers.openai.com/api/docs/guides/structured-outputs',
    ],
  },
  {
    key: 'claude-sonnet',
    label: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 64_000,
    structuredOutputMethod: 'functionCalling',
    inputModalities: ['text', 'image'],
    thinkingControl: 'none',
    aliases: [
      'claude-sonnet-4-6',
      'claude-sonnet-4.6',
      'claude-sonnet-4-5',
      'claude-sonnet-4.5',
      'claude-sonnet-4',
    ],
    officialDocs: [
      'https://platform.claude.com/docs/en/about-claude/models/overview',
    ],
  },
  {
    key: 'qwen',
    label: 'Qwen 3.7 Max',
    provider: 'aliyun',
    model: 'qwen3.7-max',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    contextWindowTokens: 1_000_000,
    structuredOutputMethod: 'jsonMode',
    inputModalities: ['text'],
    thinkingControl: 'extra_body_enable_thinking',
    aliases: [
      'qwen3.7-',
      'qwen3.6-',
      'qwen3.5-',
    ],
    officialDocs: [
      'https://help.aliyun.com/zh/model-studio/models',
      'https://help.aliyun.com/zh/model-studio/qwen-structured-output',
    ],
  },
  {
    key: 'qwen-token-plan',
    label: 'Qwen 3.8 Max',
    provider: 'aliyun',
    model: 'qwen3.8-max',
    contextWindowTokens: 983_616,
    maxOutputTokens: 131_072,
    structuredOutputMethod: 'jsonMode',
    inputModalities: ['text', 'image'],
    thinkingControl: 'always_enabled',
    aliases: [
      'qwen3.8-',
    ],
    officialDocs: [
      'https://help.aliyun.com/zh/model-studio/models',
      'https://help.aliyun.com/zh/model-studio/token-plan-overview',
      'https://help.aliyun.com/zh/model-studio/qwen-structured-output',
    ],
  },
  {
    key: 'minimax',
    label: 'MiniMax M2.7',
    provider: 'minimax',
    model: 'MiniMax-M2.7',
    baseUrl: 'https://api.minimax.chat/v1',
    contextWindowTokens: 192_000,
    structuredOutputMethod: 'jsonMode',
    inputModalities: ['text'],
    thinkingControl: 'extra_body_enable_thinking',
    aliases: [
      'minimax-m2.7',
      'minimax-m2.6',
      'minimax-m2',
    ],
    officialDocs: [
      'https://help.aliyun.com/zh/model-studio/models',
      'https://arxiv.org/abs/2605.26494',
    ],
  },
  {
    key: 'glm',
    label: 'GLM-5.2',
    provider: 'zhipu',
    model: 'glm-5.2',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 128_000,
    structuredOutputMethod: 'jsonMode',
    inputModalities: ['text'],
    thinkingControl: 'thinking_type',
    aliases: [
      'glm-5.2',
    ],
    officialDocs: [
      'https://docs.bigmodel.cn/cn/guide/models/text/glm-5.2',
      'https://docs.bigmodel.cn/cn/guide/capabilities/struct-output',
    ],
  },
  {
    key: 'kimi-code',
    label: 'Kimi Code K3',
    provider: 'kimi-code',
    model: 'k3',
    baseUrl: 'https://api.kimi.com/coding/v1',
    contextWindowTokens: 1_048_576,
    structuredOutputMethod: 'jsonSchema',
    inputModalities: ['text', 'image'],
    thinkingControl: 'always_enabled',
    aliases: [
      'k3',
    ],
    officialDocs: [
      'https://www.kimi.com/code/docs/',
      'https://www.kimi.com/code/docs/kimi-code/models.html',
    ],
  },
  {
    key: 'kimi',
    label: 'Kimi K2.7 Code',
    provider: 'moonshot',
    model: 'kimi-k2.7-code',
    baseUrl: 'https://api.moonshot.ai/v1',
    contextWindowTokens: 256_000,
    structuredOutputMethod: 'jsonSchema',
    inputModalities: ['text'],
    thinkingControl: 'always_enabled',
    aliases: [
      'kimi-k2.7-code',
      'kimi-k2.7',
      'kimi-k2.6',
    ],
    officialDocs: [
      'https://platform.kimi.ai/docs/models',
      'https://platform.kimi.ai/docs/api/chat',
    ],
  },
  {
    key: 'deepseek',
    label: 'DeepSeek V4 Pro',
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    baseUrl: 'https://api.deepseek.com',
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 384_000,
    structuredOutputMethod: 'functionCalling',
    inputModalities: ['text'],
    thinkingControl: 'thinking_type',
    aliases: [
      'deepseek-v4-pro',
      'deepseek-v4',
      'deepseek-chat',
      'deepseek-reasoner',
    ],
    officialDocs: [
      'https://api-docs.deepseek.com/quick_start/pricing',
      'https://api-docs.deepseek.com/guides/json_mode',
    ],
  },
  {
    key: 'deepseek-flash',
    label: 'DeepSeek V4 Flash',
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    baseUrl: 'https://api.deepseek.com',
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 384_000,
    structuredOutputMethod: 'functionCalling',
    inputModalities: ['text'],
    thinkingControl: 'thinking_type',
    aliases: [
      'deepseek-v4-flash',
    ],
    officialDocs: [
      'https://api-docs.deepseek.com/quick_start/pricing',
      'https://api-docs.deepseek.com/guides/json_mode',
    ],
  },
  {
    key: 'gemini',
    label: 'Gemini 3.5 Flash',
    provider: 'google',
    model: 'gemini-3.5-flash',
    contextWindowTokens: 1_048_576,
    maxOutputTokens: 65_536,
    structuredOutputMethod: 'jsonSchema',
    inputModalities: ['text', 'image'],
    thinkingControl: 'none',
    aliases: [
      'gemini-3.5-',
      'gemini-3.1-',
      'gemini-3-',
      'gemini-2.5-',
      'gemini-2.0-',
    ],
    officialDocs: [
      'https://ai.google.dev/gemini-api/docs/models',
      'https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash',
    ],
  },
];

const STRUCTURED_OUTPUT_ENDPOINT_RULES: ReadonlyArray<{
  method: StructuredOutputMethod;
  baseUrlIncludes: readonly string[];
}> = [
  {
    method: 'jsonMode',
    baseUrlIncludes: ['dashscope.aliyuncs.com', 'maas.aliyuncs.com'],
  },
];

const STRUCTURED_OUTPUT_FALLBACK_MODEL_RULES: ReadonlyArray<{
  method: StructuredOutputMethod;
  contains: readonly string[];
}> = [
  {
    method: 'jsonMode',
    contains: ['deepseek', 'qwen', 'glm', 'minimax'],
  },
];

function normalizeModelName(model: string) {
  return model.trim().toLowerCase().replace(/^models\//, '').replace(/^[^/]+\//, '');
}

function matchesAlias(normalizedModel: string, alias: string) {
  const normalizedAlias = normalizeModelName(alias);
  return normalizedModel === normalizedAlias || normalizedModel.startsWith(normalizedAlias);
}

function matchesPresetExactly(normalizedModel: string, preset: LlmModelPreset) {
  return normalizedModel === preset.key.toLowerCase()
    || normalizedModel === normalizeModelName(preset.model)
    || preset.aliases.some((alias) => normalizedModel === normalizeModelName(alias));
}

function matchesPreset(normalizedModel: string, preset: LlmModelPreset) {
  return matchesAlias(normalizedModel, preset.model)
    || preset.aliases.some((alias) => matchesAlias(normalizedModel, alias));
}

export function listLlmModelPresets() {
  return LLM_MODEL_PRESETS;
}

export function findLlmModelPresetByKey(key: string | null | undefined): LlmModelPreset | undefined {
  if (!key) return undefined;
  const normalized = normalizeModelName(key);
  return LLM_MODEL_PRESETS.find((preset) => matchesPresetExactly(normalized, preset))
    ?? LLM_MODEL_PRESETS.find((preset) => matchesPreset(normalized, preset));
}

export function inferLlmModelPreset(model: string | null | undefined): LlmModelPreset | undefined {
  const normalized = normalizeModelName(model ?? '');
  if (!normalized) return undefined;
  return LLM_MODEL_PRESETS.find((preset) => matchesPresetExactly(normalized, preset))
    ?? LLM_MODEL_PRESETS.find((preset) => matchesPreset(normalized, preset));
}

export function inferLlmStructuredOutputMethod(
  model: string,
  baseUrl: string,
): StructuredOutputMethod | undefined {
  const preset = inferLlmModelPreset(model);
  const normalizedBaseUrl = baseUrl.toLowerCase();
  const endpointMethod = STRUCTURED_OUTPUT_ENDPOINT_RULES.find((rule) =>
    rule.baseUrlIncludes.some((marker) => normalizedBaseUrl.includes(marker)),
  )?.method;
  if (endpointMethod) return endpointMethod;

  if (preset?.structuredOutputMethod) return preset.structuredOutputMethod;

  const normalizedModel = normalizeModelName(model);
  return STRUCTURED_OUTPUT_FALLBACK_MODEL_RULES.find((rule) =>
    rule.contains.some((fragment) => normalizedModel.includes(fragment)),
  )?.method;
}

export function inferLlmRoleReasoningEffort(
  model: string,
  role: LlmRuntimeRole,
): LlmReasoningEffort | undefined {
  if (inferLlmModelPreset(model)?.key !== 'qwen-token-plan') return undefined;
  return role === 'decision' || role === 'observe' ? 'low' : 'medium';
}

export function inferLlmAdditionalThinkingReserveTokens(model: string): number {
  return inferLlmModelPreset(model)?.key === 'qwen-token-plan' ? 16_384 : 0;
}

export function buildLlmModelKwargs(
  model: string,
  thinking: boolean,
  reasoningEffort?: LlmReasoningEffort,
): Record<string, unknown> | undefined {
  const normalized = normalizeModelName(model);
  const control = inferLlmModelPreset(model)?.thinkingControl;
  if (control === 'extra_body_enable_thinking') {
    return { extra_body: { enable_thinking: thinking } };
  }
  if (control === 'thinking_type') {
    return { thinking: { type: thinking ? 'enabled' : 'disabled' } };
  }
  if (control === 'always_enabled') {
    return reasoningEffort
      ? { reasoning_effort: reasoningEffort }
      : undefined;
  }
  if (normalized.includes('qwen') || normalized.includes('minimax')) {
    return { extra_body: { enable_thinking: thinking } };
  }
  if (normalized.includes('glm') || normalized.includes('deepseek')) {
    return { thinking: { type: thinking ? 'enabled' : 'disabled' } };
  }
  return undefined;
}

export function requiresLlmStreaming(model: string): boolean {
  const normalized = normalizeModelName(model);
  return inferLlmModelPreset(model)?.requiresStreaming === true
    || normalized.includes('glm-4.5');
}
