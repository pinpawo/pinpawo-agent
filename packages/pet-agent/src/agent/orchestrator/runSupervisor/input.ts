import { getAgentMessageMetadata } from '../../messages';
import type { OrchestratorStateType } from '../state';
import type { RunSupervisorInput } from './runner';
import type { SupervisorHandoffContext } from './controlContext';

/**
 * Entry means this run has not reached Supervisor yet; Boundary means it is
 * returning to its own turn. The snapshot records the run that entered it, so
 * this is a state read rather than a reconstruction from message shape — a
 * routing pair in the transcript is a consequence of the decision, not its
 * source of truth.
 */
export function readSupervisorMode(root: OrchestratorStateType): RunSupervisorInput['mode'] {
  return root.runSupervisorState.runId === root.runId ? 'boundary' : 'entry';
}

export function supervisorHandoffContext(input: RunSupervisorInput): SupervisorHandoffContext {
  return {
    state: input.state, runId: input.runId, taskId: input.taskId,
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
    runId: root.runId, taskId: root.taskId, userRequest: root.runUserRequest,
    state: root.runSupervisorState, messages: root.messages, catalog, capabilityDisclosure,
  };
}
