import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { getAgentMessageMetadata } from '../../messages';
import { controlSchema, supervisorControlSchemas, type SupervisorControl } from './protocol';
import type { SupervisorHandoffContext, SupervisorDecision } from './controlContext';
import { submitPlan } from './submitPlanTool';
import { reviewCurrent } from './reviewCurrentTool';
import { adjustPlan } from './adjustPlanTool';
import { delegateCapability } from './delegateCapabilityTool';

function replayControl(context: SupervisorHandoffContext, control: SupervisorControl, callId: string, feedback?: string): SupervisorDecision {
  if (!context.runId || !context.traceId || !callId) throw new Error('Handoff requires run and call identities.');
  switch (control.name) {
    case 'submit_plan': return submitPlan(context, control.args, callId);
    case 'review_current': return reviewCurrent(context, control.args);
    case 'adjust_plan': return adjustPlan(context, control.args, callId);
    case 'delegate_capability': return delegateCapability(context, feedback);
  }
}

/** Fold local confirmations, or the final canonical request handed to Root. */
export function resolveTranscript(context: SupervisorHandoffContext, messages: readonly BaseMessage[],
  mode: 'complete' | 'pending' | 'handoff' = 'complete') {
  let state = context.state;
  let execution: SupervisorDecision['execution'] = null;
  let executionCall: { id: string; index: number } | null = null;
  let feedback: string | undefined;
  const seen = new Set<string>();
  for (let index = 0; index < messages.length; index++) {
    const request = messages[index];
    if (ToolMessage.isInstance(request) && Object.hasOwn(supervisorControlSchemas, request.name ?? '')) {
      throw new Error('Supervisor handoff requires an exclusive control call.');
    }
    if (!AIMessage.isInstance(request)
      || !request.tool_calls?.some(call => Object.hasOwn(supervisorControlSchemas, call.name))) continue;
    if (request.invalid_tool_calls?.length || request.tool_calls.length !== 1) {
      throw new Error('Supervisor handoff requires an exclusive control call.');
    }
    const call = request.tool_calls[0];
    const canonical = mode === 'handoff' && index === messages.length - 1 && call.name === 'delegate_capability';
    const callId = canonical ? getAgentMessageMetadata(request).sourceToolCallId : call.id;
    if (typeof callId !== 'string' || !callId || !call.id) throw new Error('Supervisor tool call requires a tool call id.');
    const confirmation = messages[index + 1];
    if (!canonical) {
      if (!ToolMessage.isInstance(confirmation)) {
        if (mode === 'pending' && index === messages.length - 1) break;
        throw new Error('Supervisor handoff requires a completed exclusive control call.');
      }
      if (call.name !== confirmation.name || call.id !== confirmation.tool_call_id) {
        throw new Error('Supervisor control confirmation does not match its call.');
      }
    }
    if (seen.has(callId) || context.messages.some(message => AIMessage.isInstance(message)
      && getAgentMessageMetadata(message).runId === context.runId
      && (getAgentMessageMetadata(message).sourceToolCallId === callId
        || (getAgentMessageMetadata(message).lane === 'supervisor'
          && message.tool_calls?.some(previous => previous.id === callId))))) {
      throw new Error('Supervisor control call was already accepted.');
    }
    seen.add(callId);
    if (!canonical) index++;
    if (!canonical && ToolMessage.isInstance(confirmation) && confirmation.status === 'error') continue;
    if (executionCall) throw new Error('Supervisor must yield after requesting execution.');
    const control = controlSchema.parse({ name: call.name, args: call.args });
    const resolved = replayControl({ ...context, state }, control, callId, feedback);
    if (control.name === 'review_current') feedback = control.args.completed ? undefined : control.args.reason;
    if (control.name === 'submit_plan' || control.name === 'adjust_plan') feedback = undefined;
    state = resolved.state;
    execution = resolved.execution;
    if (execution) {
      if (index !== messages.length - 1) throw new Error('Supervisor must yield after requesting execution.');
      executionCall = { id: callId, index: canonical ? index : index - 1 };
    }
  }
  return { state, execution, executionCall, feedback };
}
