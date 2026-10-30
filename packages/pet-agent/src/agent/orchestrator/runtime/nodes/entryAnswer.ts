import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage, type ToolCall } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { tool, type ToolRuntime } from '@langchain/core/tools';
import { isDeepStrictEqual } from 'node:util';
import { Command, END, START, StateGraph } from '@langchain/langgraph';
import { ToolNode, toolsCondition } from '@langchain/langgraph/prebuilt';
import { z } from 'zod';
import {
  mainConversationMessages,
  observeAgentMessageSelection,
  queryAgentMessages,
  stampAgentMessageCreatedAt,
  setAgentMessageMetadata,
} from '../../../messages';
import type { RunSupervisorState } from '../../runSupervisor/state';
import { escapeXmlAttribute, indentXmlBlock, xmlTextBlock } from '../../../../prompts/xml';
import { isToolCallContentBlock } from '../../../../utils/messages';
import { invokeOrchestratorModel } from '../../modelInvocation';
import { buildEntryAnswerSystemPrompt } from '../../prompts';
import { OrchestratorState, type OrchestratorStateType } from '../../state';
import type { OrchestratorConfig } from '../../types';

export const PLAN_REQUEST_TOOL_NAME = 'plan_request';

export const MAX_PLAN_REQUEST_GOAL_CHARS = 2_000;

function readCurrentUserRequest(messages: BaseMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?._getType() !== 'human') continue;
    if (typeof message.content === 'string') {
      return message.content.trim() ? message.content : null;
    }
    const text = message.text;
    return text.trim() ? text : null;
  }
  return null;
}

/**
 * Seed runUserRequest with the latest human message before Entry Answer runs.
 *
 * This is a provisional value, not the authoritative run goal. A continuation
 * utterance ("嗯，开始吧") is a valid message but not a statable goal, and this
 * node cannot tell the difference — it has no view of what the utterance refers
 * back to. Entry Answer resolves the real goal against the whole conversation
 * and commits it through plan_request's `goal` argument; until then this value
 * only has to be non-empty so the state invariant holds.
 */
export function captureRunUserRequest(state: OrchestratorStateType) {
  const runUserRequest = readCurrentUserRequest(mainConversationMessages(state.messages));
  if (!runUserRequest) {
    throw new Error('Entry Answer requires a current HumanMessage.');
  }
  return {
    runUserRequest,
  };
}

/**
 * Resolve the authoritative run goal from the plan_request argument, which the
 * tool schema has already trimmed and bounded. Supervisor input and Capability
 * execution read this resolved run request; accepted planning decisions retain
 * the goal in runSupervisorState.
 *
 * When the resolved goal is just the current message again, the original is kept
 * byte-for-byte. The verbatim guarantee matters for requests whose formatting is
 * part of the content (pasted code, exact paths, deliberate layout), and it is
 * only worth spending when the model actually had to look past the current
 * message — which is exactly the continuation-utterance case.
 */
function resolveRunUserRequest(state: OrchestratorStateType, goal: string) {
  const provisional = state.runUserRequest;
  return provisional?.trim() === goal ? provisional : goal;
}

function requireRunUserRequest(state: OrchestratorStateType) {
  const request = state.runUserRequest;
  if (!request?.trim()) {
    throw new Error('Entry Answer requires a current user request.');
  }
  return request;
}

function entryHandoff(
  runtime: ToolRuntime<OrchestratorStateType>,
  runUserRequest: string,
  update: Partial<OrchestratorStateType> = {},
) {
  const last = runtime.state.messages.at(-1);
  if (!AIMessage.isInstance(last) || last.tool_calls?.length !== 1 || last.tool_calls[0].id !== runtime.toolCallId) {
    throw new Error('Entry routing requires one exclusive tool call.');
  }
  const confirmation = setAgentMessageMetadata(new ToolMessage({
    name: last.tool_calls[0].name, tool_call_id: runtime.toolCallId,
    content: 'Request handed to Supervisor.',
  }), { runId: runtime.state.runId, taskId: runtime.state.taskId });
  const messages = [last, confirmation];
  return new Command({
    graph: Command.PARENT,
    update: { ...update, runUserRequest, messages },
    goto: 'runSupervisor',
  });
}

export function createContinueTool() {
  return tool(async ({ goal }: { goal?: string }, runtime: ToolRuntime<OrchestratorStateType>) => {
    const saved = runtime.state.runSupervisorState;
    if (!saved.plan.some((task) => !['completed', 'superseded'].includes(task.status))) {
      throw new Error('No unfinished plan is available to continue.');
    }
    // Choosing to continue adopts the saved plan into this run, so Supervisor
    // enters at a boundary over facts it now owns rather than re-entering.
    if (!goal) {
      return entryHandoff(runtime, requireRunUserRequest(runtime.state), {
        runSupervisorState: { ...saved, runId: runtime.state.runId },
      });
    }
    // The user widened or changed the goal while continuing: Entry owns the
    // goal, so it replaces it here, and the old calibration no longer applies.
    const { adjustedGoal: _calibration, ...plan } = saved;
    return entryHandoff(runtime, resolveRunUserRequest(runtime.state, goal), {
      runSupervisorState: { ...plan, runId: runtime.state.runId, goal },
    });
  }, {
    name: 'continue',
    description: 'Continue the unfinished tasks in the current plan. Do not use it when the plan has no unfinished tasks; use plan_request for a new request.',
    schema: z.object({
      goal: z.string().trim().min(1).max(MAX_PLAN_REQUEST_GOAL_CHARS).optional()
        .describe('Fill in only when the user adjusted the goal or scope while continuing: combine the original goal with what the user said this time and write the complete updated goal, in the output language the user asked for if they named one. Omit it to keep the original goal.'),
    }).strict(),
  });
}

/** Shared by runtime and evaluations. */
export function createPlanRequestTool() {
  return tool(
    async ({ goal }: { goal: string }, runtime: ToolRuntime<OrchestratorStateType>) => {
      // Commit the resolved request with the routing messages before Supervisor runs.
      // A new request retires the saved plan: Supervisor plans it from an empty
      // snapshot instead of inheriting an earlier run's goal and items.
      const runUserRequest = resolveRunUserRequest(runtime.state, goal);
      return entryHandoff(runtime, runUserRequest, {
        runSupervisorState: { runId: null, goal: null, plan: [] },
      });
    },
    {
      name: PLAN_REQUEST_TOOL_NAME,
      description: 'Create an execution plan for the user\'s current goal.',
      schema: z.object({
        goal: z.string().trim().min(1).max(MAX_PLAN_REQUEST_GOAL_CHARS)
          .describe('The goal the user currently wants to achieve. State it clearly using the conversation context, keep the user\'s requirements, and do not widen the task scope yourself. Write it in the output language the user asked for if they named one; otherwise, in the language of their request.'),
      }).strict(),
    },
  );
}

/**
 * Project the Supervisor snapshot for the routing decision.
 *
 * `origin` states where these facts came from. Supervisor state outlives a run,
 * so without it the model cannot tell a plan built moments ago from one a past
 * request abandoned — and that distinction is what choosing between `continue`
 * and `plan_request` turns on. "No plan yet" is its own answer rather than a
 * degenerate previous run, so the three cases stay distinct.
 *
 * Plan item ids are deliberately omitted: they are content hashes the model
 * never cites, and `continue` takes no arguments. The runtime renders the
 * facts; the choice stays the model's.
 */
export function entryPlanMessage(state: RunSupervisorState, runId?: string) {
  const origin = !state.runId && state.plan.length === 0 ? 'none'
    : state.runId && state.runId === runId ? 'current_run'
    : 'previous_run';
  const body = state.plan.length > 0 || state.goal
    ? [
        ...(state.goal ? [indentXmlBlock(xmlTextBlock('goal', state.goal), 2)] : []),
        ...(state.adjustedGoal ? [indentXmlBlock(xmlTextBlock('adjusted_goal', state.adjustedGoal), 2)] : []),
        ...(state.plan.length > 0
          ? [
              '  <plan>',
              ...state.plan.map((item) => [
                `    <item capability="${escapeXmlAttribute(item.capability)}" status="${item.status}">`,
                indentXmlBlock(xmlTextBlock('objective', item.objective), 6),
                '    </item>',
              ].join('\n')),
              '  </plan>',
            ]
          : ['  <plan />']),
      ]
    : ['  <none />'];
  return new HumanMessage({
    content: [
      `<supervisor_snapshot role="fact" source="orchestrator_state" trust="read_only" origin="${origin}">`,
      ...body,
      '</supervisor_snapshot>',
    ].join('\n'),
  });
}

/** Drop repeated calls everywhere the message lists them, keeping `kept`. */
function withoutRepeatedCalls(message: AIMessage, kept: ToolCall[]) {
  const ids = new Set(kept.map((call) => call.id));
  const isDropped = (block: unknown) => !ids.has((block as { id?: string }).id);
  const rawCalls = message.additional_kwargs?.tool_calls;
  return new AIMessage({
    ...message,
    content: Array.isArray(message.content)
      ? message.content.filter((block) => !isToolCallContentBlock(block) || !isDropped(block))
      : message.content,
    additional_kwargs: Array.isArray(rawCalls)
      ? { ...message.additional_kwargs, tool_calls: rawCalls.filter((call) => !isDropped(call)) }
      : message.additional_kwargs,
    tool_calls: kept,
  });
}

export function createEntryAnswerSubgraph(config: OrchestratorConfig) {
  const planRequest = createPlanRequestTool();
  const continuePlan = createContinueTool();
  const answerModel = config.models.answer ?? config.models.act;
  if (!answerModel.bindTools) {
    throw new Error('Entry Answer model must support tool binding.');
  }
  // Ask for one routing call. A provider that still returns several distinct
  // calls fails the protocol check below; the hint is not paired with a repair turn.
  const routingOptions: Parameters<NonNullable<typeof answerModel.bindTools>>[1]
    & { parallel_tool_calls: boolean } = { parallel_tool_calls: false };
  const model = answerModel.bindTools([planRequest, continuePlan], routingOptions);
  const routingTools = new ToolNode<typeof OrchestratorState.State>([planRequest, continuePlan]);

  const invokeModel = async (
    state: OrchestratorStateType,
    runnableConfig?: RunnableConfig,
  ) => {
    const mainSelection = queryAgentMessages(state.messages).main().select();
    observeAgentMessageSelection(
      'entry_answer.main',
      mainSelection.diagnostics,
      runnableConfig,
    );
    const systemMessage = new SystemMessage(buildEntryAnswerSystemPrompt());
    const snapshot = entryPlanMessage(state.runSupervisorState, state.runId);
    const response = await invokeOrchestratorModel(model, {
      systemMessage,
      messages: [snapshot, ...mainSelection.messages],
      history: state.messages,
    }, runnableConfig);
    if (!AIMessage.isInstance(response)) {
      throw new Error('Entry Answer model must return an AIMessage.');
    }
    // Routing picks one path per turn and a reply must say something; any other
    // output is a protocol error, not something to repair or paper over.
    // Some providers ignore parallel_tool_calls and emit the same call twice
    // under different IDs; repeats of one name and arguments are still one
    // route, so they collapse to the first. Calls that differ in either fail.
    const toolCalls = response.tool_calls?.filter((call, index, calls) => calls.findIndex((other) =>
      other.name === call.name && isDeepStrictEqual(other.args, call.args)) === index);
    if ((toolCalls?.length ?? 0) > 1) {
      const names = toolCalls!.map((call) => call.name).join(', ');
      throw new Error(`Entry routing requires one tool call, got ${toolCalls!.length} distinct: ${names}.`);
    }
    if (!toolCalls?.length && !response.text.trim()) {
      throw new Error('Entry Answer must reply or request routing.');
    }
    const committed = toolCalls?.length === response.tool_calls?.length ? response : withoutRepeatedCalls(response, toolCalls!);
    return {
      messages: [setAgentMessageMetadata(stampAgentMessageCreatedAt(committed), { taskId: state.taskId, runId: state.runId })],
    };
  };

  return new StateGraph(OrchestratorState)
    .addNode('model', invokeModel)
    .addNode('tools', routingTools)
    .addEdge(START, 'model')
    .addConditionalEdges('model', toolsCondition, {
      tools: 'tools',
      [END]: END,
    })
    .addEdge('tools', 'model')
    .compile({ name: 'entryAnswer' });
}
