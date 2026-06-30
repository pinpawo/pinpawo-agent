import { AIMessage } from '@langchain/core/messages';
import {
  CAPABILITY_SEARCH_TOOL_NAME,
  readModelToolCalls,
} from '../../capabilitySearch';
import {
  getMessageLane,
  getMessageTurnId,
} from '../../messageLanes';
import type { OrchestratorStateType } from '../../state';

export function afterCapabilityDiscovery(state: OrchestratorStateType) {
  const latestMessage = state.messages[state.messages.length - 1];
  if (
    latestMessage?._getType() === 'ai'
    && getMessageLane(latestMessage) === 'orchestrator'
    && getMessageTurnId(latestMessage) === state.runId
    && readModelToolCalls(latestMessage as AIMessage).some((call) => call.name === CAPABILITY_SEARCH_TOOL_NAME)
  ) {
    return 'capabilitySearch';
  }
  return 'prepareUserIntentDecision';
}
