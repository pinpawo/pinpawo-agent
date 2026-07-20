import { toJsonSchema } from '@langchain/core/utils/json_schema';
import { z } from 'zod';
import type { StructuredOutputMethod } from '../../utils/structuredOutput';
import type {
  OrchestrationDecisionStructuredOutputConfig,
  OrchestrationDecisionStructuredOutputOptions,
} from './types';

const ROUTE_CAPABILITY_PREFIX = 'capability.' as const;

export type RouteCapabilityLane = `${typeof ROUTE_CAPABILITY_PREFIX}${string}`;

export type TaskDecision = {
  action: 'answer' | 'direct_task' | 'needs_plan';
  task?: string | null;
  context_summary?: string | null;
};

export type CapabilityPlanTaskDecision = {
  objective: string;
  capability_intent: string;
  status: 'concrete' | 'deferred';
};

export type CapabilityPlanningDecision = {
  result: 'next_task' | 'answer';
  remaining_plan: CapabilityPlanTaskDecision[];
  next_task: { objective: string; capability_intent: string } | null;
};

export type DelegationOutcomeDecision = {
  outcome: 'continue' | 'task_done' | 'goal_done';
  gap_note: string | null;
};

export type RouteDecision = {
  lane: 'general' | RouteCapabilityLane;
};

export type OrchestrationDecisionSchemaParams = {
  capabilityCandidates: ReadonlyArray<{ name: string }>;
};

export function buildRouteCapabilityLane(capabilityName: string): RouteCapabilityLane {
  return `${ROUTE_CAPABILITY_PREFIX}${capabilityName}` as RouteCapabilityLane;
}

export function parseRouteLane(lane: string): {
  kind: 'general' | 'capability';
  capabilityName: string | null;
} {
  if (lane.startsWith(ROUTE_CAPABILITY_PREFIX)) {
    return {
      kind: 'capability',
      capabilityName: lane.slice(ROUTE_CAPABILITY_PREFIX.length) || null,
    };
  }
  return { kind: 'general', capabilityName: null };
}

function validateCapabilityCandidateNames(params: OrchestrationDecisionSchemaParams) {
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
    action: z.enum(['answer', 'direct_task', 'needs_plan']).describe(
      'run 入口执行形态。answer=基于对话中的已有信息回复；direct_task=执行一个当前任务；needs_plan=先规划多个任务。',
    ),
    task: z.string().nullable().optional().describe(
      'action=direct_task 时要执行的单步任务；其他 action 为 null 或省略。',
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
    objective: z.string().trim().min(1).describe('后续尚未开始的任务目标。'),
    capability_intent: z.string().trim().min(1).describe('任务需要的能力类型。'),
    status: z.enum(['concrete', 'deferred']).describe('concrete=现在可以执行；deferred=仍依赖未来结果。'),
  });
  return z.object({
    result: z.enum(['next_task', 'answer']).describe('next_task=输出本轮要执行的任务；answer=没有后续执行。'),
    remaining_plan: z.array(planTask).describe(
      'result=next_task 时只包含 next_task 之后尚未开始的任务；result=answer 时为空数组。',
    ),
    next_task: z.object({
      objective: z.string().trim().min(1).describe('本轮唯一的当前任务，应当可以直接执行并得到可验收结果。'),
      capability_intent: z.string().trim().min(1).describe('当前任务需要的能力类型。'),
    }).nullable().describe('result=next_task 时为当前任务；result=answer 时为 null。'),
  }).superRefine((decision, ctx) => {
    if (decision.result === 'next_task' && !decision.next_task) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['next_task'], message: 'next_task result requires a concrete next_task.' });
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
    outcome: z.enum(['continue', 'task_done', 'goal_done']).describe(
      'continue=当前 task 未达标且同一 capability 可以继续；task_done=当前 task 达标但不能明确断言用户目标已经完成；goal_done=用户目标已经完成，或继续前需要用户补充、澄清、确认。',
    ),
    gap_note: z.string().trim().min(1).nullable().describe(
      'outcome=continue 时为当前 task 的具体缺口；没有可补充的具体缺口时为 null。其他 outcome 为 null。',
    ),
    // Normalize instead of reject: gap_note is advisory and outcome is the
    // authoritative field, so a stray gap_note on task_done/goal_done is
    // harmless model noise — stripping it keeps the continue-only contract
    // structural without turning noise into a failed run (autoRepair defaults
    // to zero retries). A null gap on continue stays valid: the schema cannot
    // see completionReason, and limit_reached can continue without a new gap.
  }).transform((decision) => (
    decision.outcome === 'continue'
      ? decision
      : { ...decision, gap_note: null }
  ));
}

export function buildRouteDecisionSchema(params: OrchestrationDecisionSchemaParams) {
  validateCapabilityCandidateNames(params);
  const laneValues = [
    'general',
    ...params.capabilityCandidates.map((c) => buildRouteCapabilityLane(c.name)),
  ] as [string, ...string[]];
  const capabilityLaneValues = params.capabilityCandidates.map((c) => buildRouteCapabilityLane(c.name));

  return z.object({
    lane: z.enum(laneValues).describe(
      capabilityLaneValues.length > 0
        ? `选择执行当前 task 的 capability；结果用 lane 编码。当前 capability lane：${capabilityLaneValues.join('、')}。`
        : '选择执行当前 task 的 capability；结果用 lane 编码。当前没有可选 capability lane。',
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

export function buildRouteDecisionOutputInstruction(
  params: OrchestrationDecisionSchemaParams,
  method?: StructuredOutputMethod,
): string {
  return buildDecisionOutputInstruction('route decision', buildRouteDecisionSchema(params), method);
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
