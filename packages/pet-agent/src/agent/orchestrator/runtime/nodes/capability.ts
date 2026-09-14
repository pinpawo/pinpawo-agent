import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { ToolInputParsingException, type StructuredTool } from '@langchain/core/tools';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { OrchestratorStateType } from '../../state';
import { SupervisorDecisionError } from '../../runSupervisor/controlContext';
import { currentSupervisorTask } from '../../runSupervisor/state';
import { setAgentMessageMetadata } from '../../../messages';

export function createCapabilityNode(delegateCapability: StructuredTool) {
  const tools = new ToolNode([delegateCapability], { handleToolErrors: false });
  return async (state: OrchestratorStateType, config?: RunnableConfig) => {
    try {
      const last = state.messages.at(-1);
      if (!AIMessage.isInstance(last) || last.tool_calls?.length !== 1) throw new Error('Capability requires one pending tool call.');
      // ToolNode inherits callbacks from the current graph task; passing them again duplicates handlers.
      return await tools.invoke({ ...state, lg_tool_call: last.tool_calls[0] }, { ...config, callbacks: undefined });
    } catch (error) {
      if (!(error instanceof ToolInputParsingException) && !(error instanceof SupervisorDecisionError)) throw error;
      const last = state.messages.at(-1);
      if (!AIMessage.isInstance(last) || last.tool_calls?.length !== 1) throw error;
      return { messages: [setAgentMessageMetadata(new ToolMessage({
        name: delegateCapability.name, tool_call_id: last.tool_calls[0].id!, status: 'error',
        content: JSON.stringify({ error: error.message, currentTask: currentSupervisorTask(state.runSupervisorState), plan: state.runSupervisorState }),
      }), { runId: state.runId, traceId: state.traceId })], runIterationCount: state.runIterationCount + 1 };
    }
  };
}
