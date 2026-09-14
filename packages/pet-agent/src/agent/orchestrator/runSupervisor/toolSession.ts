import { ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { ToolRuntime } from '@langchain/core/tools';
import { currentSupervisorTask } from './state';
import { SupervisorDecisionError, type SupervisorHandoffContext, type SupervisorDecision } from './controlContext';
import { resolveTranscript } from './controlTranscript';
import type { SupervisorControl } from './protocol';

export type SupervisorToolSession = ReturnType<typeof createSupervisorToolSession>;

/** Read this invocation's confirmed state; each tool supplies its own decision. */
export function createSupervisorToolSession(context: SupervisorHandoffContext, messageOffset = 0) {
  return (runtime: ToolRuntime, name: SupervisorControl['name'],
    decide: (current: SupervisorHandoffContext, callId: string, feedback?: string) => SupervisorDecision): ToolMessage => {
    const messages = (((runtime.state ?? {}) as { messages?: BaseMessage[] }).messages ?? []).slice(messageOffset);
    const current = resolveTranscript(context, messages, 'pending');
    if (!context.runId || !context.traceId || !runtime.toolCallId) throw new Error('Handoff requires run and call identities.');
    try {
      const result = decide({ ...context, state: current.state }, runtime.toolCallId, current.feedback);
      return new ToolMessage({ name, tool_call_id: runtime.toolCallId,
        content: JSON.stringify({ plan: result.state, ...(result.execution ? { handoff: true } : {}) }) });
    } catch (error) {
      if (!(error instanceof SupervisorDecisionError)) throw error;
      return new ToolMessage({ name, tool_call_id: runtime.toolCallId, status: 'error',
        content: JSON.stringify({ error: error.message, currentTask: currentSupervisorTask(current.state), plan: current.state }) });
    }
  };
}
