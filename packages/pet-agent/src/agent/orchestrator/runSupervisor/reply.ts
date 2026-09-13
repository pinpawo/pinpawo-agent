import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { getAgentMessageMetadata } from '../../messages';
import type { OrchestratorStateType } from '../state';
import { legacyReviewSchema } from './protocol';

/** Read only the current run's committed reply; never reuse an older decision. */
export function readSupervisorReply(state: Pick<OrchestratorStateType, 'messages' | 'runId' | 'traceId'>): string | null {
  const work = state.messages.filter((message) => {
    const metadata = getAgentMessageMetadata(message);
    return metadata.lane === 'supervisor' && metadata.runId === state.runId && metadata.traceId === state.traceId;
  });
  const last = work.at(-1);
  if (AIMessage.isInstance(last) && !last.tool_calls?.length) return last.text.trim() ? last.text : null;
  // A pre-upgrade checkpoint may already be waiting at answer. Read its
  // committed reply without exposing the legacy shape to the model or rerunning work.
  const request = work.at(-2);
  if (!ToolMessage.isInstance(last) || last.status === 'error' || last.name !== 'review_current'
    || !AIMessage.isInstance(request) || request.invalid_tool_calls?.length || request.tool_calls?.length !== 1) return null;
  const call = request.tool_calls[0];
  if (!call.id || call.id !== last.tool_call_id || call.name !== last.name) return null;
  const parsed = legacyReviewSchema.safeParse({ name: call.name, args: call.args });
  return parsed.success ? parsed.data.args.reply ?? null : null;
}
