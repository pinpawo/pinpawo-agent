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
  action: 'answer' | 'next_task';
  task?: string | null;
  context_summary?: string | null;
  search_keywords?: string | null;
};

export type DelegationOutcomeDecision = {
  outcome: 'continue' | 'task_done' | 'goal_done';
  gap_note?: string | null;
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
    action: z.enum(['answer', 'next_task']).describe(
      '下一步动作。answer 表示不需要执行器；next_task 表示先产出一个单步 delegated task。',
    ),
    task: z.string().nullable().optional().describe(
      'action=next_task 时要执行的单步任务；action=answer 时为 null 或省略。',
    ),
    context_summary: z.string().nullable().optional().describe(
      'action=next_task 时执行器需要的简短上下文；action=answer 时为 null 或省略。',
    ),
    search_keywords: z.string().nullable().optional().describe(
      'action=next_task 时用于 capability search 的关键词或短语；多个词用 | 分隔。没有更好关键词时可为 null。',
    ),
  }).superRefine((decision, ctx) => {
    if (decision.action === 'next_task' && !decision.task?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['task'],
        message: 'action=next_task requires a non-empty task.',
      });
    }
  });
}

export function buildDelegationOutcomeDecisionSchema() {
  return z.object({
    outcome: z.enum(['continue', 'task_done', 'goal_done']).describe(
      '验收结论。continue=当前 task 未达标，同一 capability 继续；task_done=当前 task 达标但总目标未完；goal_done=不再自主执行，交给 answer，通常因为目标已满足或需要用户澄清/确认。',
    ),
    gap_note: z.string().nullable().optional().describe(
      'outcome=continue 或 task_done 时可填写缺口/下一步依据的简短说明；goal_done 时为 null 或省略。',
    ),
  });
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
