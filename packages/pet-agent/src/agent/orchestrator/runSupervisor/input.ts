import { getAgentMessageMetadata } from '../../messages';
import type { OrchestratorStateType } from '../state';
import type { RunSupervisorDispatch, RunSupervisorInput } from './runner';
import type { SupervisorHandoffContext } from './messageHandoff';

export function isSupervisorDispatch(input: OrchestratorStateType | RunSupervisorDispatch): input is RunSupervisorDispatch {
  return 'root' in input;
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
  nodeInput: OrchestratorStateType | RunSupervisorDispatch;
  catalog: RunSupervisorInput['catalog'];
  capabilityDisclosure: RunSupervisorInput['capabilityDisclosure'];
}): RunSupervisorInput {
  const { nodeInput, catalog, capabilityDisclosure } = params;
  const root = isSupervisorDispatch(nodeInput) ? nodeInput.root : nodeInput;
  if (!root.runUserRequest) throw new Error('Supervisor requires the current user request.');
  const latestHuman = root.messages.filter((message) => message._getType() === 'human'
    && !getAgentMessageMetadata(message).lane && getAgentMessageMetadata(message).runId === root.runId).at(-1);
  const humanId = latestHuman ? `human:${latestHuman.id ?? root.runId}` : null;
  return {
    mode: isSupervisorDispatch(nodeInput) ? nodeInput.mode : 'boundary',
    inputId: humanId && root.runSupervisorUserMessageId !== humanId
      ? humanId : `boundary:${root.runId}:${root.runIterationCount}`,
    runId: root.runId, traceId: root.traceId, userRequest: root.runUserRequest,
    state: root.runSupervisorState, messages: root.messages, catalog, capabilityDisclosure,
  };
}
