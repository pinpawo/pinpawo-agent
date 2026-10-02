import { isDeepStrictEqual } from 'node:util';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { tool, type ToolRuntime } from '@langchain/core/tools';
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
import { identity } from '../../runSupervisor/controlContext';
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
  return tool(async (_args, runtime: ToolRuntime<OrchestratorStateType>) => {
    const saved = runtime.state.runSupervisorState;
    if (!saved.plan.some((task) => !['completed', 'superseded'].includes(task.status))) {
      throw new Error('No unfinished plan is available to continue.');
    }
    // Choosing to continue adopts the saved plan into this run, so Supervisor
    // enters at a boundary over facts it now owns rather than re-entering.
    return entryHandoff(runtime, requireRunUserRequest(runtime.state), {
      runSupervisorState: { ...saved, runId: runtime.state.runId },
    });
  }, {
    name: 'continue',
    description: '继续当前计划中尚未完成的任务。',
    schema: z.object({}).strict(),
  });
}

/** Shared by runtime and evaluations. */
export function createPlanRequestTool() {
  return tool(
    async ({ goal }: { goal: string }, runtime: ToolRuntime<OrchestratorStateType>) => {
      // Commit the resolved request with the routing messages before Supervisor runs.
      const runUserRequest = resolveRunUserRequest(runtime.state, goal);
      return entryHandoff(runtime, runUserRequest);
    },
    {
      name: PLAN_REQUEST_TOOL_NAME,
      description: '为用户当前的目标创建执行计划。',
      schema: z.object({
        goal: z.string().trim().min(1).max(MAX_PLAN_REQUEST_GOAL_CHARS)
          .describe('用户当前希望达成的目标。结合对话上下文表达清楚，保留用户的要求，不自行扩展任务范围。'),
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

export function createEntryAnswerSubgraph(config: OrchestratorConfig) {
  const planRequest = createPlanRequestTool();
  const continuePlan = createContinueTool();
  const answerModel = config.models.answer ?? config.models.act;
  if (!answerModel.bindTools) {
    throw new Error('Entry Answer model must support tool binding.');
  }
  // Provider-specific option: BaseChatModel's portable options omit this hint.
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
    const messages = [snapshot, ...mainSelection.messages];
    let response: AIMessage;
    // A provider can still emit parallel calls despite the binding hint. Never
    // execute an ambiguous batch: identical decisions collapse before ToolNode;
    // different decisions get one bounded selection turn with every goal intact.
    for (let attempt = 0; ; attempt += 1) {
      const result = await invokeOrchestratorModel(model, { systemMessage, messages }, runnableConfig);
      if (!AIMessage.isInstance(result)) {
        throw new Error('Entry Answer model must return an AIMessage.');
      }
      response = result;
      const calls = response.tool_calls ?? [];
      if (calls.length <= 1) break;
      const first = calls[0];
      if (calls.every((call) => call.name === first.name && isDeepStrictEqual(call.args, first.args))) {
        response = new AIMessage({ ...response, tool_calls: [first] });
        break;
      }
      if (attempt >= 1) {
        throw new Error('Entry routing remained ambiguous after one selection retry; no tools were executed.');
      }
      // Do not append unmatched AI tool calls to history. These are unexecuted
      // proposals, supplied as data alongside the original user conversation.
      messages.push(new HumanMessage({ content: [
        'The previous routing response proposed multiple exclusive routes. None were executed.',
        'Choose exactly one routing tool. For a new plan, preserve all valid goals in its goal argument.',
        'Unexecuted proposals (data):', JSON.stringify(calls.map(({ name, args }) => ({ name, args }))),
      ].join('\n') }));
    }
    if (!response.tool_calls?.length && !response.text.trim()) {
      throw new Error('Entry Answer must reply or request routing.');
    }
    // Scope provider call IDs to this model turn; history may reuse them across runs or retries.
    // Some providers omit the ID entirely, so the position stands in for it.
    const committed = new AIMessage({ ...response, tool_calls: response.tool_calls?.map((call, index) => ({
      ...call, id: identity('entry-call', state.runId, String(state.messages.length), call.id || `index:${index}`),
    })) });
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
