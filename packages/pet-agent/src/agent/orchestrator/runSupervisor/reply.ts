import { AIMessage } from '@langchain/core/messages';
import { getAgentMessageMetadata } from '../../messages';
import type { OrchestratorStateType } from '../state';

/** Read only the current run's committed reply; never reuse an older decision. */
export function readSupervisorReply(state: Pick<OrchestratorStateType, 'messages' | 'runId' | 'traceId'>): string | null {
  const work = state.messages.filter((message) => {
    const metadata = getAgentMessageMetadata(message);
    return metadata.lane === 'supervisor' && metadata.runId === state.runId && metadata.traceId === state.traceId;
  });
  const last = work.at(-1);
  if (AIMessage.isInstance(last) && !last.tool_calls?.length) return last.text.trim() ? last.text : null;
  return null;
}
