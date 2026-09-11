import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { getAgentMessageMetadata } from '../../messages';
import type { OrchestratorStateType } from '../state';
import type { RunSupervisorInput } from './runner';
import type { SupervisorHandoffContext } from './messageHandoff';

/** Entry intent is already checkpointed in the actual routing tool pair. */
export function readSupervisorMode(root: OrchestratorStateType): RunSupervisorInput['mode'] {
  const main = root.messages.filter((message) => {
    const metadata = getAgentMessageMetadata(message);
    return !metadata.lane && metadata.runId === root.runId && metadata.traceId === root.traceId;
  });
  const result = main.at(-1);
  const request = main.at(-2);
  return ToolMessage.isInstance(result) && result.name === 'plan_request' && result.status !== 'error'
    && AIMessage.isInstance(request) && request.tool_calls?.length === 1
    && request.tool_calls[0].name === 'plan_request' && request.tool_calls[0].id === result.tool_call_id
    ? 'entry' : 'boundary';
}

export function supervisorHandoffContext(input: RunSupervisorInput): SupervisorHandoffContext {
  return {
    state: input.state, runId: input.runId, traceId: input.traceId,
    userRequest: input.userRequest, mode: input.mode,
    hasNewUserInput: input.inputId.startsWith('human:'),
    allowedCapabilityNames: input.catalog.capabilityNames, messages: input.messages,
  };
}

export function buildRunSupervisorInput(params: {
  root: OrchestratorStateType;
  catalog: RunSupervisorInput['catalog'];
  capabilityDisclosure: RunSupervisorInput['capabilityDisclosure'];
}): RunSupervisorInput {
  const { root, catalog, capabilityDisclosure } = params;
  if (!root.runUserRequest) throw new Error('Supervisor requires the current user request.');
  const latestHuman = root.messages.filter((message) => message._getType() === 'human'
    && !getAgentMessageMetadata(message).lane && getAgentMessageMetadata(message).runId === root.runId).at(-1);
  const humanId = latestHuman ? `human:${latestHuman.id ?? root.runId}` : null;
  return {
    mode: readSupervisorMode(root),
    inputId: humanId && root.runSupervisorUserMessageId !== humanId
      ? humanId : `boundary:${root.runId}:${root.runIterationCount}`,
    runId: root.runId, traceId: root.traceId, userRequest: root.runUserRequest,
    state: root.runSupervisorState, messages: root.messages, catalog, capabilityDisclosure,
  };
}
