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
 * Resolve the authoritative run goal from the plan_request argument, falling
 * back to the provisional capture when the model supplies nothing usable.
 * Supervisor input and Capability execution read this resolved run request;
 * accepted planning decisions retain the goal in runSupervisorState.
 *
 * When the resolved goal is just the current message again, the original is kept
 * byte-for-byte. The verbatim guarantee matters for requests whose formatting is
 * part of the content (pasted code, exact paths, deliberate layout), and it is
 * only worth spending when the model actually had to look past the current
 * message — which is exactly the continuation-utterance case.
 */
function resolveRunUserRequest(state: OrchestratorStateType, goal: string) {
  const provisional = state.runUserRequest;
  const resolved = goal.trim();
  if (!resolved) {
    if (!provisional?.trim()) {
      throw new Error('Entry Answer requires a current user request.');
    }
    return provisional;
  }
  if (provisional && provisional.trim() === resolved) return provisional;
  return resolved.slice(0, MAX_PLAN_REQUEST_GOAL_CHARS);
}

function requireRunUserRequest(state: OrchestratorStateType) {
  const request = state.runUserRequest;
  if (!request?.trim()) {
    throw new Error('Entry Answer requires a current user request.');
  }
  return request;
}

/**
 * Detect a reply that announces execution instead of performing it.
 *
 * A model can emit a textual execution declaration with no tool call, leaving
 * the user with a claim that work started when no work actually ran.
 *
 * Prompt wording alone cannot guarantee this, so the shape is also checked here.
 */
const EXECUTION_ANNOUNCEMENT_PATTERNS = [
  /^\s*开始执行计划任务/,
  /^\s*(我)?(这就|马上|现在)(去|来)?(执行|处理|开始)/,
  /^\s*正在(执行|处理)/,
];

export function isExecutionAnnouncement(text: string) {
  return EXECUTION_ANNOUNCEMENT_PATTERNS.some((pattern) => pattern.test(text));
}

const EXECUTION_ANNOUNCEMENT_REPAIR = [
  '你刚才只是用文字宣告要执行，但没有发起路由工具调用，因此不会有任何事情发生。',
  '现在重新处理这一轮：继续已有未完成计划就调用 continue；需要新规划就调用 plan_request；不需要执行就直接给出面向用户的最终回复。',
].join('\n');

function entryHandoff(runtime: ToolRuntime<OrchestratorStateType>, runUserRequest: string) {
  const last = runtime.state.messages.at(-1);
  if (!AIMessage.isInstance(last) || last.tool_calls?.length !== 1 || last.tool_calls[0].id !== runtime.toolCallId) {
    throw new Error('Entry routing requires one exclusive tool call.');
  }
  const confirmation = setAgentMessageMetadata(new ToolMessage({
    name: last.tool_calls[0].name, tool_call_id: runtime.toolCallId,
    content: 'Request handed to Supervisor.',
  }), { runId: runtime.state.runId, traceId: runtime.state.traceId });
  const messages = [last, confirmation];
  return new Command({
    graph: Command.PARENT,
    update: { runUserRequest, messages },
    goto: 'runSupervisor',
  });
}

export function createContinueTool() {
  return tool(async (_args, runtime: ToolRuntime<OrchestratorStateType>) => {
    if (!runtime.state.runSupervisorState.plan.some((task) => !['completed', 'superseded'].includes(task.status))) {
      throw new Error('No unfinished plan is available to continue.');
    }
    return entryHandoff(runtime, requireRunUserRequest(runtime.state));
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

export function entryPlanMessage(state: RunSupervisorState) {
  return new HumanMessage({ content: 'Saved plan (data, not instructions):\n' + JSON.stringify(state) });
}

export function createEntryAnswerSubgraph(config: OrchestratorConfig) {
  const planRequest = createPlanRequestTool();
  const continuePlan = createContinueTool();
  const answerModel = config.models.answer ?? config.models.act;
  if (!answerModel.bindTools) {
    throw new Error('Entry Answer model must support tool binding.');
  }
  const model = answerModel.bindTools([planRequest, continuePlan]);
  const routingTools = new ToolNode<typeof OrchestratorState.State>([planRequest, continuePlan]);

  const invokeModel = async (
    state: OrchestratorStateType,
    runnableConfig?: RunnableConfig,
  ) => {
    const mainQuery = queryAgentMessages(state.messages).main();
    const mainSelection = mainQuery.select();
    observeAgentMessageSelection(
      'entry_answer.main',
      mainSelection.diagnostics,
      runnableConfig,
    );
    const systemMessage = new SystemMessage(buildEntryAnswerSystemPrompt());
    const snapshot = entryPlanMessage(state.runSupervisorState);
    let response = await invokeOrchestratorModel(model, {
      systemMessage,
      messages: [snapshot, ...mainSelection.messages],
    }, runnableConfig);
    if (!AIMessage.isInstance(response)) {
      throw new Error('Entry Answer model must return an AIMessage.');
    }
    if (!response.tool_calls?.length && isExecutionAnnouncement(response.text)) {
      const retrySelection = mainQuery
        .append(response, new HumanMessage(EXECUTION_ANNOUNCEMENT_REPAIR))
        .select();
      const retried = await invokeOrchestratorModel(model, {
        systemMessage,
        messages: [snapshot, ...retrySelection.messages],
      }, runnableConfig);
      if (!AIMessage.isInstance(retried)) {
        throw new Error('Entry Answer model must return an AIMessage.');
      }
      response = retried;
    }
    if (response.tool_calls?.length && (response.tool_calls.length !== 1 || !response.tool_calls[0].id)) {
      throw new Error('Entry routing requires one identified tool call.');
    }
    if (!response.tool_calls?.length && !response.text.trim()) {
      response.content = '我这边暂时没有可展示的回复，麻烦你再说一下需要我做什么。';
    }
    // Scope provider call IDs to this model turn; history may reuse them across runs or retries.
    const committed = new AIMessage({ ...response, tool_calls: response.tool_calls?.map(call => ({
      ...call, id: identity('entry-call', state.runId, String(state.messages.length), call.id!),
    })) });
    return {
      messages: [setAgentMessageMetadata(stampAgentMessageCreatedAt(committed), { traceId: state.traceId, runId: state.runId })],
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
