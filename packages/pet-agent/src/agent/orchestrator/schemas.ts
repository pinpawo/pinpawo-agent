import { toJsonSchema } from '@langchain/core/utils/json_schema';
import { z } from 'zod';
import type { StructuredOutputMethod } from '../../utils/structuredOutput';
import type {
  OrchestrationDecisionStructuredOutputConfig,
  OrchestrationDecisionStructuredOutputOptions,
} from './types';

export type TaskDecision = {
  action: 'answer' | 'direct_task' | 'needs_plan';
  task?: string | null;
  context_summary?: string | null;
};

export type DelegationOutcomeDecision = {
  outcome: 'continue' | 'task_done' | 'goal_done' | 'user_input_required';
  gap_note: string | null;
};
export type AcceptedDelegationOutcome = Exclude<DelegationOutcomeDecision['outcome'], 'continue'>;

export function buildTaskDecisionSchema() {
  return z.object({
    action: z.enum(['direct_task', 'needs_plan', 'answer']).describe(
      'run 入口的下一步。answer=主对话已有回复所需结果或需要询问用户；direct_task=需要先取得一个结果；needs_plan=需要先规划多个或依赖前一结果的任务。',
    ),
    task: z.string().nullable().optional().describe(
      'action=direct_task 时要执行的完整任务；其他 action 为 null 或省略。',
    ),
    context_summary: z.string().nullable().optional().describe(
      'action=direct_task 时执行器需要的简短上下文；其他 action 为 null 或省略。',
    ),
  }).superRefine((decision, ctx) => {
    if (decision.action === 'direct_task' && !decision.task?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['task'],
        message: 'action=direct_task requires a non-empty task.',
      });
    }
  });
}

export function buildDelegationOutcomeDecisionSchema() {
  return z.object({
    outcome: z.enum(['goal_done', 'user_input_required', 'task_done', 'continue']).describe(
      'goal_done=用户目标已经完成；user_input_required=用户目标尚未完成，下一次进展必须先等待用户补充、澄清或确认；task_done=当前 task 已达标且之后仍可自主规划；continue=当前 task 未达标且同一 capability 可以继续。',
    ),
    gap_note: z.string().trim().nullable().optional().describe(
      'outcome=continue 时为当前 task 的具体缺口；没有可补充的具体缺口时可为 null 或省略。其他 outcome 可为 null 或省略。',
    ),
    // Normalize instead of reject: gap_note is advisory and outcome is the
    // authoritative field, so a stray gap_note on any non-continue outcome is
    // harmless model noise — stripping it keeps the continue-only contract
    // structural without turning noise into a failed run (autoRepair defaults
    // to zero retries). A missing, null, or blank gap on continue stays valid:
    // the schema cannot see completionReason, and limit_reached can continue
    // without a new gap. Normalize every accepted shape for stable runtime use.
  }).transform((decision) => ({
    ...decision,
    gap_note: decision.outcome === 'continue' ? decision.gap_note || null : null,
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

export function buildTaskDecisionOutputInstruction(method?: StructuredOutputMethod): string {
  return buildDecisionOutputInstruction('task decision', buildTaskDecisionSchema(), method);
}

export function buildDelegationOutcomeDecisionOutputInstruction(method?: StructuredOutputMethod): string {
  return buildDecisionOutputInstruction(
    'delegation outcome decision',
    buildDelegationOutcomeDecisionSchema(),
    method,
  );
}

export function readDecisionText(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}
