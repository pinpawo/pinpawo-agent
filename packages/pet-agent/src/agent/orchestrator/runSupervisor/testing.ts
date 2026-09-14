import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { tool, type ToolRuntime } from '@langchain/core/tools';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { recoverCapabilityError } from '../runtime/capabilityError';
import { Command, StateGraph, START, END } from '@langchain/langgraph';
import { createRunSupervisorAgent } from './agent';
import { OrchestratorState } from '../state';
import { setAgentMessageMetadata } from '../../messages';
import { randomUUID } from 'node:crypto';
import { AIMessage, AIMessageChunk, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { RunSupervisorInput, RunSupervisorResult, RunSupervisorRunner } from './runner';
import { supervisorWorkMessages } from './messageHandoff';
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
function scriptedSupervisorDecisions(decision: ScriptedSupervisorDecision) {
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
  return decisions;
}

export function scriptedSupervisorResult(input: RunSupervisorInput, decision: ScriptedSupervisorDecision): RunSupervisorResult {
  return scriptedSupervisorSequence(input, scriptedSupervisorDecisions(decision));
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
    if (execution) messages.push(request);
    else messages.push(request, new ToolMessage({ name: control.name, tool_call_id: callId, content: 'Scenario tool result.' }));

  };
  let reply: string | undefined;
  for (const decision of decisions) {
    if ('reply' in decision) reply = decision.reply;
    else call(decision);
  }
  if (reply !== undefined) messages.push(new AIMessage({ id: `${id}:reply`, content: reply }));
  return { runSupervisorState: state, reviewFeedback: feedback ?? null, capabilityDisclosure: input.capabilityDisclosure,
    messages: supervisorWorkMessages(supervisorHandoffContext(input), messages) };
}

/** Script only model outputs; real agent tools and parent handoff perform all state changes. */
export function withScriptedDelegation(runner: ScriptedSupervisorRunner): RunSupervisorRunner {
  return { invoke: async (input, config) => {
    const decision = await runner.invoke(input, config);
    const responses = scriptedSupervisorDecisions(decision).map((step, index) => 'reply' in step
      ? new AIMessageChunk(step.reply)
      : new AIMessageChunk({ content: '', tool_calls: [{ id: `scripted:${randomUUID()}:${index}`, name: step.name, args: step.args }] }));
    class ScriptedModel extends BaseChatModel {
      _llmType() { return 'scripted-supervisor'; }
      bindTools() { return this; }
      async _generate(): Promise<never> { throw new Error('Scripted model uses explicit responses.'); }
      async invoke() {
        const response = responses.shift();
        if (!response) throw new Error('Unexpected Supervisor model turn.');
        return response;
      }
    }
    return createRunSupervisorAgent({ model: new ScriptedModel({}) }).invoke({ ...input,
      capabilityDisclosure: decision.capabilityDisclosure ?? input.capabilityDisclosure }, config);
  } };
}

/** Real native parent graph for decision-only tests/evals; Capability is deliberately not executed. */
export function createRunSupervisorProbe(params: Parameters<typeof createRunSupervisorAgent>[0]): RunSupervisorRunner {
  const runner = createRunSupervisorAgent(params);
  return { invoke: async (input, config) => {
    const capture = tool((_args, runtime: ToolRuntime<typeof OrchestratorState.State>) => {
      buildCapabilityExecutionInput({ ...supervisorHandoffContext(input), state: runtime.state.runSupervisorState,
        messages: [...input.messages, ...runtime.state.messages] }, runtime.state.runSupervisorReviewFeedback ?? undefined);
      return new Command({ update: {} });
    }, { name: 'delegate_capability', description: 'Capture a valid execution decision without executing Capability.', schema: delegateCapabilitySchema });
    const graph = new StateGraph(OrchestratorState)
      .addNode('runSupervisor', async (_state, runtime) => {
        const result = await runner.invoke({ ...input, state: _state.runSupervisorState, reviewFeedback: _state.runSupervisorReviewFeedback,
          messages: [...input.messages, ..._state.messages] }, runtime);
        return new Command({ update: { messages: result.messages, runSupervisorState: result.runSupervisorState,
          runCapabilityDisclosure: result.capabilityDisclosure, runSupervisorReviewFeedback: result.reviewFeedback ?? null }, goto: END });
      }, { ends: ['capability', END] })
      .addNode('capability', new ToolNode<typeof OrchestratorState.State>([capture], { handleToolErrors: false }), {
        ends: ['runSupervisor'],
        errorHandler: (state: typeof OrchestratorState.State, error) => {
          const recovery = recoverCapabilityError(state, error);
          if (recovery) return recovery;
          throw error.error;
        },
      })
      .addEdge(START, 'runSupervisor').addConditionalEdges('capability', state =>
        ToolMessage.isInstance(state.messages.at(-1)) ? 'runSupervisor' : END, ['runSupervisor', END]).compile();
    const result = await graph.invoke({ runId: input.runId, traceId: input.traceId,
      runSupervisorState: input.state, runSupervisorReviewFeedback: input.reviewFeedback ?? null, runUserRequest: input.userRequest, runCapabilityDisclosure: input.capabilityDisclosure }, config);
    return { messages: result.messages, runSupervisorState: result.runSupervisorState,
      reviewFeedback: result.runSupervisorReviewFeedback,
      capabilityDisclosure: result.runCapabilityDisclosure! };
  } };
}

/** Fixture for an actual returned execution, matching the native tool's result artifact. */
export function capabilityResultMessage(state: { runId: string; traceId: string },
  call: { id: string; taskId: string; delegationId: string; capability: string; task: string; mode: 'initial' | 'continue'; briefing?: string },
  result: { status: string; delivery: unknown; artifacts: unknown[] }) {
  const { id, ...input } = call;
  return setAgentMessageMetadata(new ToolMessage({ name: 'delegate_capability', tool_call_id: id,
    content: JSON.stringify(result), artifact: { ...input, briefing: input.briefing ?? JSON.stringify({ plan: [] }) },
    status: result.status === 'missing_deliverable' ? 'error' : 'success',
  }), { runId: state.runId, traceId: state.traceId });
}

/** Evaluation convenience; production replies exist only as committed messages. */
export function supervisorReply(result: Pick<RunSupervisorResult, 'messages'>) {
  const last = result.messages.at(-1);
  return AIMessage.isInstance(last) && !last.tool_calls?.length ? last.text : undefined;
}
