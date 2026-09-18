import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { ToolInputParsingException } from '@langchain/core/tools';
import { Command, type NodeError } from '@langchain/langgraph';
import type { OrchestratorStateType } from '../state';
import { SupervisorDecisionError } from '../runSupervisor/controlContext';
import { currentSupervisorTask } from '../runSupervisor/state';
import { setAgentMessageMetadata } from '../../messages';

/** Recover only correctable tool errors; other failures use Root termination. */
export function recoverCapabilityError(state: OrchestratorStateType, { error }: NodeError) {
  if (!(error instanceof ToolInputParsingException) && !(error instanceof SupervisorDecisionError)) return;
  const message = state.messages.at(-1);
  if (!AIMessage.isInstance(message) || message.tool_calls?.length !== 1) return;
  const call = message.tool_calls[0];
  return new Command({ goto: 'runSupervisor', update: {
    messages: [setAgentMessageMetadata(new ToolMessage({
      name: call.name, tool_call_id: call.id!, status: 'error',
      content: JSON.stringify({ error: error.message, currentTask: currentSupervisorTask(state.runSupervisorState), plan: state.runSupervisorState }),
    }), { runId: state.runId, taskId: state.taskId })],
    runIterationCount: state.runIterationCount + 1,
  } });
}
