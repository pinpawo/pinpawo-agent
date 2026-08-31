import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { tool, type ToolRuntime } from '@langchain/core/tools';
import { Command, END, Send, START, StateGraph } from '@langchain/langgraph';
import { ToolNode, toolsCondition } from '@langchain/langgraph/prebuilt';
import { z } from 'zod';
import {
  mainConversationMessages,
  observeAgentMessageSelection,
  queryAgentMessages,
  stampAgentMessageCreatedAt,
} from '../../../messages';
import { modelVisibleMessages } from '../../modelMessageView';
import { buildEntryAnswerSystemPrompt } from '../../prompts';
import { OrchestratorState, type OrchestratorStateType } from '../../state';
import type { OrchestratorConfig } from '../../types';
import { resolveActor } from '../config';
import type { CapabilityPlannerDispatch } from '../../capabilityPlanner/runner';

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
    runNextDelegation: null,
    runPlannerSession: null,
    taskPlannerContinuation: null,
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
  '你刚才只是用文字宣告要执行，但没有发起 plan_request 工具调用，因此不会有任何事情发生。',
  '现在重新处理这一轮：需要执行就发起 plan_request 工具调用；不需要执行就直接给出面向用户的最终回复。',
].join('\n');

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
      runPlannerSession: null,
    },
    messages: state.messages,
  };
}

/** Exported so evals can assert their stub still mirrors this contract. */
export function createPlanRequestTool() {
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
          runPlannerSession: null,
        },
        goto: new Send('capabilityPlanner', plannerDispatch(runtime.state, runUserRequest)),
      });
    },
    {
      name: PLAN_REQUEST_TOOL_NAME,
      description: 'Hand the current user request to the Capability Planner when satisfying it requires any tool, external capability, or task execution.',
      schema: z.object({
        goal: z.string().trim().min(1).max(MAX_PLAN_REQUEST_GOAL_CHARS)
          .describe('用户当前要达成的目标，用用户自己的话陈述。默认直接用用户当前这句话；只在其中含有指代（“这个 PR”“继续”“开始吧”）时，把指代替换成它在对话中指向的具体对象。除替换指代外不要新增用户没说过的内容——不写执行步骤、检查项、关注维度、输出格式或技术方案。保留用户给出的编号、URL、路径和显式约束。'),
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
    const mainSelection = queryAgentMessages(state.messages).main().select();
    observeAgentMessageSelection(
      'entry_answer.main',
      mainSelection.diagnostics,
      runnableConfig,
    );
    const history = [
      new SystemMessage(buildEntryAnswerSystemPrompt({
        actor: resolveActor(config, runnableConfig),
      })),
      ...modelVisibleMessages(mainSelection.messages),
    ];
    let response = await model.invoke(history, runnableConfig);
    if (!AIMessage.isInstance(response)) {
      throw new Error('Entry Answer model must return an AIMessage.');
    }
    if (!response.tool_calls?.length && isExecutionAnnouncement(response.text)) {
      const retried = await model.invoke([
        ...history,
        response,
        new HumanMessage(EXECUTION_ANNOUNCEMENT_REPAIR),
      ], runnableConfig);
      if (!AIMessage.isInstance(retried)) {
        throw new Error('Entry Answer model must return an AIMessage.');
      }
      response = retried;
    }
    if (!response.tool_calls?.length && !response.text.trim()) {
      response.content = '我这边暂时没有可展示的回复，麻烦你再说一下需要我做什么。';
    }
    return {
      messages: [stampAgentMessageCreatedAt(response)],
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
