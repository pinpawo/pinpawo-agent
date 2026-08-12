import { toJsonSchema } from '@langchain/core/utils/json_schema';
import { z } from 'zod';
import type { StructuredOutputMethod } from '../../utils/structuredOutput';
import type {
  OrchestrationDecisionStructuredOutputConfig,
  OrchestrationDecisionStructuredOutputOptions,
} from './types';
import {
  USER_GOAL_CONTEXT_MAX_CHARS,
  USER_GOAL_OBJECTIVE_MAX_CHARS,
} from './capabilityPlanner/runner';

export type EntryDecision = {
  action: 'answer' | 'needs_plan';
  planner_objective: string | null;
  planner_context: string | null;
};

export function buildEntryDecisionSchema() {
  return z.object({
    action: z.enum(['needs_plan', 'answer']).describe(
      'run 入口的下一步。answer=当前仍缺少完成请求必需的目标、范围或选择，或当前表述无法理解时，直接询问用户并暂不开始任务执行；也用于完成当前请求不需要调用工具的情况。needs_plan=信息足够且完成当前用户请求需要调用任何工具。',
    ),
    planner_objective: z.string().trim().min(1)
      .max(USER_GOAL_OBJECTIVE_MAX_CHARS)
      .nullable().optional().describe(
      '仅 action=needs_plan 时必填：对当前真实用户目标的准确、可执行摘要。保留编号、URL、路径、顺序和明确约束；消解必要指代。不要选择 Capability、拆分任务或写执行计划。',
    ),
    planner_context: z.string().trim().min(1)
      .max(USER_GOAL_CONTEXT_MAX_CHARS)
      .nullable().optional().describe(
      '仅 action=needs_plan 时可选：理解当前目标必需的已确认背景、约束或指代事实。排除无关历史、已关闭目标、Capability 选择和执行计划。',
    ),
  }).superRefine((decision, context) => {
    if (decision.action === 'needs_plan' && !decision.planner_objective) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['planner_objective'],
        message: 'planner_objective is required when action is needs_plan.',
      });
    }
  }).transform((decision): EntryDecision => ({
    action: decision.action,
    planner_objective: decision.action === 'needs_plan'
      ? decision.planner_objective ?? null
      : null,
    planner_context: decision.action === 'needs_plan'
      ? decision.planner_context ?? null
      : null,
  }));
}

export function buildOrchestrationDecisionStructuredOutputOptions(
  config?: OrchestrationDecisionStructuredOutputConfig,
): OrchestrationDecisionStructuredOutputOptions {
  return {
    name: 'orchestration_decision',
    ...(config?.method ? { method: config.method } : {}),
    ...(typeof config?.strict === 'boolean' ? { strict: config.strict } : {}),
    ...(typeof config?.autoRepair !== 'undefined' ? { autoRepair: config.autoRepair } : {}),
  };
}

function buildDecisionOutputInstruction(
  label: string,
  schema: z.ZodTypeAny,
  method?: StructuredOutputMethod,
): string {
  const baseInstruction = `输出符合 structured-output schema 的 ${label}；不要输出 schema 未声明的字段。`;
  if (method !== 'jsonMode') return baseInstruction;

  return [
    baseInstruction,
    '当前 provider 使用 jsonMode：只输出一个 JSON object，不要输出 Markdown 代码围栏或额外文本。',
    `JSON Schema：${JSON.stringify(toJsonSchema(schema))}`,
  ].join('\n');
}

export function buildEntryDecisionOutputInstruction(method?: StructuredOutputMethod): string {
  return buildDecisionOutputInstruction('entry decision', buildEntryDecisionSchema(), method);
}

export function readDecisionText(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}
