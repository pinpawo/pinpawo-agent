import type { AIMessage, BaseMessage } from '@langchain/core/messages';
import { HumanMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { tool, type StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import {
  CAPABILITY_PLANNER_BRIEFING_CONTEXT_MAX_CHARS,
  CAPABILITY_PLANNER_BRIEFING_OBJECTIVE_MAX_CHARS,
  type CapabilityPlannerBriefing,
} from '../../capabilityPlanner/runner';
import {
  buildEntryDecisionSchema,
  buildOrchestrationDecisionStructuredOutputOptions,
  readDecisionText,
  type EntryDecision,
} from '../../schemas';
import type {
  OrchestratorConfig,
  ToolBindableChatModel,
} from '../../types';
import { readMessageToolCalls } from '../../../../utils/messages';
import {
  invokeStructuredOutput,
  type StructuredOutputAutoRepairConfig,
} from '../../../../utils/structuredOutput';

const ROUTE_TO_ANSWER = 'route_to_answer';
const ROUTE_TO_PLANNER = 'route_to_planner';

const routeToAnswerArgsSchema = z.object({}).strict();
const routeToPlannerArgsSchema = z.object({
  objective: z.string().trim().min(1)
    .max(CAPABILITY_PLANNER_BRIEFING_OBJECTIVE_MAX_CHARS),
  context: z.string().trim().min(1)
    .max(CAPABILITY_PLANNER_BRIEFING_CONTEXT_MAX_CHARS)
    .optional(),
}).strict();

export type EntryOutcome =
  | { kind: 'answer' }
  | { kind: 'plan'; briefing: CapabilityPlannerBriefing };

export function usesRouteFunctionEntryDecision(config: OrchestratorConfig): boolean {
  return config.decisionStructuredOutput?.entryDecisionProtocol === 'routeFunctions';
}

export function buildRouteFunctionEntryDecisionInstruction(): string {
  return [
    `必须且只能调用一个路由 function：${ROUTE_TO_ANSWER} 或 ${ROUTE_TO_PLANNER}。`,
    `选择 ${ROUTE_TO_ANSWER} 时参数必须为空；选择 ${ROUTE_TO_PLANNER} 时提供 objective，必要时提供 context。`,
    '不要输出普通文本、JSON 或调用任何其他 function。',
  ].join('\n');
}

export function buildRouteFunctionEntryDecisionBriefingInstruction(): string {
  return [
    '- route_to_planner 的 objective：当前真实用户目标的准确、可执行摘要。保留编号、URL、路径、先后顺序和显式限制；消解理解目标所必需的指代。',
    '- route_to_planner 的 context：仅保留理解该目标所需的已确认背景、约束或事实；没有则省略。',
    '- route_to_answer 不附加 Planner briefing。',
  ].join('\n');
}

export async function invokeEntryDecisionOutcome(params: {
  config: OrchestratorConfig;
  messages: BaseMessage[];
  runnableConfig?: RunnableConfig;
}): Promise<EntryOutcome> {
  if (usesRouteFunctionEntryDecision(params.config)) {
    return invokeRouteFunctionEntryDecision(params);
  }

  const decision = await invokeStructuredOutput({
    model: params.config.models.decision ?? params.config.models.act,
    schema: buildEntryDecisionSchema(),
    options: buildOrchestrationDecisionStructuredOutputOptions(
      params.config.decisionStructuredOutput,
    ),
    messages: params.messages,
    runnableConfig: params.runnableConfig,
  }) as EntryDecision;
  return entryDecisionToOutcome(decision);
}

function entryDecisionToOutcome(decision: EntryDecision): EntryOutcome {
  if (decision.action === 'answer') return { kind: 'answer' };
  const objective = readDecisionText(decision.planner_objective);
  if (!objective) {
    throw new Error('needs_plan entry decision requires planner_objective.');
  }
  return {
    kind: 'plan',
    briefing: {
      objective,
      context: readDecisionText(decision.planner_context),
    },
  };
}

async function invokeRouteFunctionEntryDecision(params: {
  config: OrchestratorConfig;
  messages: BaseMessage[];
  runnableConfig?: RunnableConfig;
}): Promise<EntryOutcome> {
  const model = params.config.models.decision ?? params.config.models.act;
  if (typeof (model as ToolBindableChatModel).bindTools !== 'function') {
    throw new Error('Entry route-functions protocol requires a model with bindTools().');
  }
  const routeModel = (model as ToolBindableChatModel).bindTools!(
    createEntryRouteTools(),
    { tool_choice: 'required' },
  );
  const maxRetries = resolveAutoRepairRetries(
    params.config.decisionStructuredOutput?.autoRepair,
  );
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const repairInstruction = attempt === 0
      ? []
      : [new HumanMessage(
        `上一次路由输出无效。${buildRouteFunctionEntryDecisionInstruction()}`,
      )];
    try {
      const message = await routeModel.invoke(
        [...params.messages, ...repairInstruction],
        params.runnableConfig,
      );
      return parseRouteFunctionOutcome(message);
    } catch (error) {
      lastError = error;
      if (attempt >= maxRetries) break;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Entry route-functions protocol failed: ${String(lastError)}`);
}

function createEntryRouteTools(): StructuredTool[] {
  return [
    tool(async () => 'route accepted', {
      name: ROUTE_TO_ANSWER,
      description: 'Reply directly using facts already available in the main conversation.',
      schema: routeToAnswerArgsSchema,
    }),
    tool(async () => 'route accepted', {
      name: ROUTE_TO_PLANNER,
      description: 'Start capability planning for a request that needs an action or a new result.',
      schema: routeToPlannerArgsSchema,
    }),
  ];
}

function parseRouteFunctionOutcome(message: AIMessage): EntryOutcome {
  const calls = readMessageToolCalls(message);
  if (calls.length !== 1) {
    throw new Error(
      `Entry route-functions protocol requires exactly one route call; received ${String(calls.length)}.`,
    );
  }
  const [call] = calls;
  if (call.name === ROUTE_TO_ANSWER) {
    const parsed = routeToAnswerArgsSchema.safeParse(call.args);
    if (!parsed.success) {
      throw new Error(`Invalid ${ROUTE_TO_ANSWER} arguments: ${parsed.error.message}`);
    }
    return { kind: 'answer' };
  }
  if (call.name === ROUTE_TO_PLANNER) {
    const parsed = routeToPlannerArgsSchema.safeParse(call.args);
    if (!parsed.success) {
      throw new Error(`Invalid ${ROUTE_TO_PLANNER} arguments: ${parsed.error.message}`);
    }
    return {
      kind: 'plan',
      briefing: {
        objective: parsed.data.objective,
        context: parsed.data.context ?? null,
      },
    };
  }
  throw new Error(`Unknown entry route function "${call.name}".`);
}

function resolveAutoRepairRetries(config: StructuredOutputAutoRepairConfig | undefined): number {
  if (!config) return 0;
  const retries = config === true ? 1 : config.maxRetries ?? 1;
  if (!Number.isFinite(retries) || retries <= 0) return 0;
  return Math.min(Math.floor(retries), 3);
}
