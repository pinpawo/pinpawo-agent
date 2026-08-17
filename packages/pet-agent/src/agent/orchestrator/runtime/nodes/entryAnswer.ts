import { AIMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { tool, type ToolRuntime } from '@langchain/core/tools';
import { Command, END, Send, START, StateGraph } from '@langchain/langgraph';
import { ToolNode, toolsCondition } from '@langchain/langgraph/prebuilt';
import { z } from 'zod';
import { mainConversationMessages, stampMessageCreatedAtUtc } from '../../messageLanes';
import { buildEntryAnswerSystemPrompt } from '../../prompts';
import { OrchestratorState, type OrchestratorStateType } from '../../state';
import type { OrchestratorConfig } from '../../types';
import { resolveActor } from '../config';
import type { CapabilityPlannerDispatch } from '../../capabilityPlanner/runner';
import { removeStaleCapabilityPlannerMessages } from '../../capabilityPlanner/messageContext';

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
    messages: removeStaleCapabilityPlannerMessages(state.messages, state.traceId),
    runUserRequest,
    runNextDelegation: null,
    runCapabilityPlan: [],
  };
}

/**
 * Resolve the authoritative run goal from the plan_request argument, falling
 * back to the provisional capture when the model supplies nothing usable.
 * Everything downstream — Planner input, Capability run context, Answer, and the
 * TaskActiveDelegation snapshot replayed on every resume — reads this one value.
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

function plannerDispatch(
  state: OrchestratorStateType,
  runUserRequest: string,
): CapabilityPlannerDispatch {
  return {
    mode: 'entry',
    plannerState: {
      runId: state.runId,
      traceId: state.traceId,
      runUserRequest,
      runDelegationSummaries: state.runDelegationSummaries,
      runCapabilityPlan: [],
    },
    messages: state.messages,
  };
}

function createPlanRequestTool() {
  return tool(
    async ({ goal }: { goal: string }, runtime: ToolRuntime<OrchestratorStateType>) => {
      // The Command update below has not been applied to runtime.state yet, so
      // the dispatch must carry the resolved goal explicitly rather than reading
      // it back from state.
      const runUserRequest = resolveRunUserRequest(runtime.state, goal);
      return new Command({
        graph: Command.PARENT,
        update: {
          runUserRequest,
          runNextDelegation: null,
          runCapabilityPlan: [],
        },
        goto: new Send('capabilityPlanner', plannerDispatch(runtime.state, runUserRequest)),
      });
    },
    {
      name: PLAN_REQUEST_TOOL_NAME,
      description: 'Hand the current user request to the Capability Planner when satisfying it requires any tool, external capability, or task execution.',
      schema: z.object({
        goal: z.string().trim().min(1).max(MAX_PLAN_REQUEST_GOAL_CHARS)
          .describe('用户当前要达成的目标，一句话陈述。当前消息是延续话语（例如“继续”“开始吧”“可以”）时，回到它所指代的那条请求，把目标补全为可独立理解的一句话；不要照抄延续话语，也不要加入执行步骤、方案或你的推断。保留用户给出的编号、URL、路径和显式约束。'),
      }).strict(),
    },
  );
}

export function createEntryAnswerSubgraph(config: OrchestratorConfig) {
  const planRequest = createPlanRequestTool();
  const answerModel = config.models.answer ?? config.models.act;
  if (!answerModel.bindTools) {
    throw new Error('Entry Answer model must support tool binding.');
  }
  const model = answerModel.bindTools([planRequest]);

  const invokeModel = async (
    state: OrchestratorStateType,
    runnableConfig?: RunnableConfig,
  ) => {
    const response = await model.invoke([
      new SystemMessage(buildEntryAnswerSystemPrompt({
        actor: resolveActor(config, runnableConfig),
      })),
      ...mainConversationMessages(state.messages),
    ], runnableConfig);
    if (!AIMessage.isInstance(response)) {
      throw new Error('Entry Answer model must return an AIMessage.');
    }
    if (!response.tool_calls?.length && !response.text.trim()) {
      response.content = '我这边暂时没有可展示的回复，麻烦你再说一下需要我做什么。';
    }
    return {
      messages: [stampMessageCreatedAtUtc(response)],
    };
  };

  return new StateGraph(OrchestratorState)
    .addNode('model', invokeModel)
    .addNode('tools', new ToolNode([planRequest]))
    .addEdge(START, 'model')
    .addConditionalEdges('model', toolsCondition, {
      tools: 'tools',
      [END]: END,
    })
    .addEdge('tools', 'model')
    .compile({ name: 'entryAnswer' });
}
