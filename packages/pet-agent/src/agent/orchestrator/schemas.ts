import { toJsonSchema } from '@langchain/core/utils/json_schema';
import { z } from 'zod';
import type { StructuredOutputMethod } from '../../utils/structuredOutput';
import type {
  OrchestrationDecisionStructuredOutputConfig,
  OrchestrationDecisionStructuredOutputOptions,
} from './types';

const CAPABILITY_SELECTION_PREFIX = 'capability.' as const;
export const CAPABILITY_UNAVAILABLE_SELECTION = 'unavailable' as const;

export type CapabilitySelectionValue =
  `${typeof CAPABILITY_SELECTION_PREFIX}${string}`;
export type CapabilitySelection =
  | typeof CAPABILITY_UNAVAILABLE_SELECTION
  | CapabilitySelectionValue;

export type TaskDecision = {
  action: 'answer' | 'direct_task' | 'needs_plan';
  task?: string | null;
  context_summary?: string | null;
};

export type CapabilityPlanTaskDecision = {
  objective: string;
  capability_intent: string;
};

export type CapabilityPlanningDecision = {
  result: 'next_task' | 'answer';
  remaining_plan: CapabilityPlanTaskDecision[];
  next_task: { objective: string; capability_intent: string } | null;
};

export type DelegationOutcomeDecision = {
  outcome: 'continue' | 'task_done' | 'goal_done' | 'user_input_required';
  gap_note: string | null;
};
export type AcceptedDelegationOutcome = Exclude<DelegationOutcomeDecision['outcome'], 'continue'>;

export type CapabilityDecision = {
  selection: CapabilitySelection;
};

export type CapabilityDecisionSchemaParams = {
  capabilityCandidates: ReadonlyArray<{ name: string }>;
};

export function buildCapabilitySelection(
  capabilityName: string,
): CapabilitySelectionValue {
  return `${CAPABILITY_SELECTION_PREFIX}${capabilityName}` as CapabilitySelectionValue;
}

export function parseCapabilitySelection(selection: string): {
  kind: 'unavailable' | 'capability' | 'invalid';
  capabilityName: string | null;
} {
  if (selection === CAPABILITY_UNAVAILABLE_SELECTION) {
    return { kind: 'unavailable', capabilityName: null };
  }
  if (selection.startsWith(CAPABILITY_SELECTION_PREFIX)) {
    return {
      kind: 'capability',
      capabilityName:
        selection.slice(CAPABILITY_SELECTION_PREFIX.length) || null,
    };
  }
  return { kind: 'invalid', capabilityName: null };
}

function validateCapabilityCandidateNames(params: CapabilityDecisionSchemaParams) {
  const seen = new Set<string>();
  for (const candidate of params.capabilityCandidates) {
    if (candidate.name.includes('.')) {
      throw new Error(
        `capability name must not contain '.': received "${candidate.name}".`,
      );
    }
    if (seen.has(candidate.name)) {
      throw new Error(`duplicate capability name in decision schema: "${candidate.name}"`);
    }
    seen.add(candidate.name);
  }
}

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

export function buildCapabilityPlanningDecisionSchema() {
  const planTask = z.object({
    objective: z.string().trim().min(1).describe('为达成用户目标，后续仍需独立执行的任务目标。'),
    capability_intent: z.string().trim().min(1).describe('任务需要的能力类型。'),
  });
  return z.object({
    result: z.enum(['next_task', 'answer']).describe('next_task=输出本轮要执行的任务；answer=没有后续执行。'),
    remaining_plan: z.array(planTask).describe(
      'result=next_task 时只包含 next_task 之后，为达成用户目标仍需独立执行的任务；result=answer 时为空数组。',
    ),
    next_task: z.object({
      objective: z.string().trim().min(1).describe('本轮唯一的当前任务，应当可以直接执行并得到可验收结果。'),
      capability_intent: z.string().trim().min(1).describe('当前任务需要的能力类型。'),
    }).nullable().describe('result=next_task 时为当前任务；result=answer 时为 null。'),
  }).superRefine((decision, ctx) => {
    if (decision.result === 'next_task' && !decision.next_task) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['next_task'], message: 'next_task result requires next_task.' });
    }
    if (decision.next_task && decision.remaining_plan.some((item) =>
      item.objective === decision.next_task?.objective
      && item.capability_intent === decision.next_task.capability_intent)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['remaining_plan'], message: 'remaining_plan must not repeat next_task.' });
    }
    if (decision.result === 'answer' && (decision.next_task || decision.remaining_plan.length > 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['remaining_plan'], message: 'answer result must have an empty plan and no next_task.' });
    }
  });
}

export function buildDelegationOutcomeDecisionSchema() {
  return z.object({
    outcome: z.enum(['continue', 'task_done', 'goal_done', 'user_input_required']).describe(
      'continue=当前 task 未达标且同一 capability 可以继续；task_done=当前 task 达标但不能明确断言用户目标已经完成；goal_done=用户目标已经完成；user_input_required=用户目标尚未完成，继续前需要用户补充、澄清或确认。',
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

export function buildCapabilityDecisionSchema(params: CapabilityDecisionSchemaParams) {
  validateCapabilityCandidateNames(params);
  const selectionValues = [
    CAPABILITY_UNAVAILABLE_SELECTION,
    ...params.capabilityCandidates.map((candidate) =>
      buildCapabilitySelection(candidate.name)),
  ] as const;

  return z.object({
    selection: z.enum(selectionValues).describe(
      '当前 task 的执行能力；unavailable=提供的执行能力都不能承担完整 task。',
    ),
  });
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

export function buildCapabilityPlanningDecisionOutputInstruction(method?: StructuredOutputMethod): string {
  return buildDecisionOutputInstruction(
    'capability planning decision',
    buildCapabilityPlanningDecisionSchema(),
    method,
  );
}

export function buildCapabilityDecisionOutputInstruction(
  params: CapabilityDecisionSchemaParams,
  method?: StructuredOutputMethod,
): string {
  return buildDecisionOutputInstruction(
    'capability decision',
    buildCapabilityDecisionSchema(params),
    method,
  );
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
