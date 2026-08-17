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

function requireRunUserRequest(state: OrchestratorStateType) {
  const request = state.runUserRequest;
  if (!request?.trim()) {
    throw new Error('Entry Answer requires a current user request.');
  }
  return request;
}

function plannerDispatch(state: OrchestratorStateType): CapabilityPlannerDispatch {
  return {
    mode: 'entry',
    plannerState: {
      runId: state.runId,
      traceId: state.traceId,
      runUserRequest: requireRunUserRequest(state),
      runDelegationSummaries: state.runDelegationSummaries,
      runCapabilityPlan: [],
    },
    messages: state.messages,
  };
}

function createPlanRequestTool() {
  return tool(
    async (_input, runtime: ToolRuntime<OrchestratorStateType>) => {
      const runUserRequest = requireRunUserRequest(runtime.state);
      return new Command({
        graph: Command.PARENT,
        update: {
          runUserRequest,
          runNextDelegation: null,
          runCapabilityPlan: [],
        },
        goto: new Send('capabilityPlanner', plannerDispatch(runtime.state)),
      });
    },
    {
      name: PLAN_REQUEST_TOOL_NAME,
      description: 'Hand the current user request to the Capability Planner when satisfying it requires any tool, external capability, or task execution. This control action takes no arguments.',
      schema: z.object({}).strict(),
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
