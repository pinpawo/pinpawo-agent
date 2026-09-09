import { ToolMessage } from '@langchain/core/messages';
import type { RunSupervisorSessionState } from '../runSupervisor/session';

/** Close a pending invocation once, whether it returned delivery or was paused. */
export function completeDelegationToolCall(
  session: RunSupervisorSessionState,
  result: unknown,
): RunSupervisorSessionState {
  const call = session.pendingCall;
  if (!call) return session;
  return {
    ...session,
    pendingCall: null,
    messages: [...(session.messages ?? []), new ToolMessage({
      id: `delegation-result:${session.runId}:${call.id}`,
      name: call.name,
      tool_call_id: call.id,
      content: JSON.stringify(result),
    })],
  };
}
