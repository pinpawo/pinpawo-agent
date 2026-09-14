import { randomUUID } from 'node:crypto';
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { RunSupervisorInput, RunSupervisorResult, RunSupervisorRunner } from './runner';
import { createSupervisorMessageHandoff, prepareCapabilityHandoff } from './messageHandoff';
import { supervisorHandoffContext } from './input';
import { submitPlan, submitPlanSchema } from './submitPlanTool';
import { adjustPlan, adjustPlanSchema } from './adjustPlanTool';
import { reviewCurrent, reviewCurrentSchema } from './reviewCurrentTool';
import { buildCapabilityExecutionInput, delegateCapabilitySchema } from './delegateCapabilityTool';

/** Test/eval projection only; production tools own and validate their own schemas. */
export function parseSupervisorControl(call: { name: string; args: unknown }) {
  switch (call.name) {
    case 'submit_plan': return { name: call.name, args: submitPlanSchema.parse(call.args) };
    case 'adjust_plan': return { name: call.name, args: adjustPlanSchema.parse(call.args) };
    case 'review_current': return { name: call.name, args: reviewCurrentSchema.parse(call.args) };
    case 'delegate_capability': return { name: call.name, args: delegateCapabilitySchema.parse(call.args) };
    default: throw new Error(`Unknown Supervisor tool: ${call.name}`);
  }
}
export type ScriptedSupervisorControl = ReturnType<typeof parseSupervisorControl>;

/** Compact fixture notation only; the runtime seam receives final state and messages. */
export type ScriptedSupervisorDecision = (ScriptedSupervisorControl | { name: 'review_current'; args: { completed?: boolean; reason: string; reply?: string } } | { reply: string }) & {
  capabilityDisclosure?: RunSupervisorInput['capabilityDisclosure'];
};
export type ScriptedSupervisorRunner = {
  invoke(input: RunSupervisorInput, config?: RunnableConfig): Promise<ScriptedSupervisorDecision>;
};

/** Compact scenario shorthand; explicit sequence fixtures can choose every model step. */
export function scriptedSupervisorResult(input: RunSupervisorInput,
  decision: ScriptedSupervisorDecision): RunSupervisorResult {
  const decisions: Array<ScriptedSupervisorControl | { reply: string }> = [];
  let reply: string | undefined;
  if ('reply' in decision) reply = decision.reply;
  else if (decision.name === 'review_current') {
    if (decision.args.completed !== undefined) decisions.push({ name: 'review_current', args: {
      completed: decision.args.completed, reason: decision.args.reason,
    } });
    reply = 'reply' in decision.args ? decision.args.reply : undefined;
    if (!reply) {
      decisions.push({ name: 'delegate_capability', args: {} });
    }
  } else {
    decisions.push(decision);
    if (decision.name !== 'delegate_capability') decisions.push({ name: 'delegate_capability', args: {} });
  }
  if (reply !== undefined) decisions.push({ reply });
  return scriptedSupervisorSequence(input, decisions);
}

/** Test-only decisions invoke the same transitions as tools; no transcript replay. */
export function scriptedSupervisorSequence(input: RunSupervisorInput,
  decisions: readonly (ScriptedSupervisorControl | { reply: string })[]): RunSupervisorResult {
  const id = `scripted:${randomUUID()}`;
  const messages: BaseMessage[] = [];
  const context = supervisorHandoffContext(input);
  let state = input.state;
  let feedback: string | undefined;
  const call = (control: ScriptedSupervisorControl) => {
    const callId = `${id}:${messages.length}`;
    const current = { ...context, state };
    const execution = control.name === 'delegate_capability' ? buildCapabilityExecutionInput(current, feedback) : undefined;
    if (control.name === 'submit_plan') state = submitPlan(current, control.args, callId);
    else if (control.name === 'adjust_plan') state = adjustPlan(current, control.args, callId);
    else if (control.name === 'review_current') state = reviewCurrent(current, control.args);
    if (control.name === 'review_current') feedback = control.args.completed ? undefined : control.args.reason;
    else if (control.name !== 'delegate_capability') feedback = undefined;
    const request = new AIMessage({ id: `request:${callId}`, content: '',
      tool_calls: [{ id: callId, name: control.name, args: control.args, type: 'tool_call' }] });
    if (execution) messages.push(prepareCapabilityHandoff(context, request, execution));
    else messages.push(request, new ToolMessage({ name: control.name, tool_call_id: callId, content: 'Scenario tool result.' }));

  };
  let reply: string | undefined;
  for (const decision of decisions) {
    if ('reply' in decision) reply = decision.reply;
    else call(decision);
  }
  if (reply !== undefined) messages.push(new AIMessage({ id: `${id}:reply`, content: reply }));
  return { runSupervisorState: state, capabilityDisclosure: input.capabilityDisclosure, ...(reply !== undefined ? { reply } : {}),
    messages: createSupervisorMessageHandoff(supervisorHandoffContext(input), messages) };
}

export function withScriptedDelegation(runner: ScriptedSupervisorRunner): RunSupervisorRunner {
  return { invoke: async (input, config) => {
    const decision = await runner.invoke(input, config);
    const result = scriptedSupervisorResult(input, decision);
    return { ...result, capabilityDisclosure: decision.capabilityDisclosure ?? result.capabilityDisclosure };
  } };
}
