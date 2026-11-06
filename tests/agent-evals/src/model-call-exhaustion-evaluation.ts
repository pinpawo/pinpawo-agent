import { randomUUID } from 'node:crypto';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { tool, type ToolRuntime } from '@langchain/core/tools';
import { END, MemorySaver, MessagesAnnotation, START, StateGraph } from '@langchain/langgraph';
import { createMiddleware } from 'langchain';
import { z } from 'zod';
import { createSubagent, SUBAGENT_GUARD_DECISION_EVENT } from '../../../packages/pet-agent/src/subagent/createSubagent.ts';
import { readSubagentGuardStopReason } from '../../../packages/pet-agent/src/subagent/guardStop.ts';
import type { AgentModels } from '../../../packages/pet-agent/src/types/agent.ts';
import type { SubagentResult, SubagentRuntimeContext } from '../../../packages/pet-agent/src/types/subagent.ts';
import { createPromptEvalUsageCollector } from './prompt-eval-usage.ts';

export type ModelCallExhaustionObservation = {
  attempts: Array<{
    taskId: string;
    delegationId: string;
    maxIterations: number;
    modelCallCount: number;
    delivery: string | null;
    guardStopReasons: string[];
  }>;
  toolCalls: Array<{ name: string; delegationId: string; success: boolean }>;
  notices: Array<{ reason: string; phase: string; paired: boolean; delegationId: string }>;
  continuationInputs: Array<{ delegationId: string; hasPriorDelivery: boolean; hasPrivateToolHistory: boolean }>;
  extraModelCallRequested: boolean;
  blockedIteration: number | null;
  handoffTicketPreserved: boolean;
  finalText: string;
  invocationError: string | null;
};

export function evaluateModelCallExhaustionInvariants(observed: ModelCallExhaustionObservation) {
  const [first, second] = observed.attempts;
  const reads = observed.toolCalls.filter(call => call.name === 'read_evidence');
  const verifies = observed.toolCalls.filter(call => call.name === 'verify_evidence');
  return [
    { key: 'invocation_succeeded', passed: observed.invocationError === null },
    { key: 'two_fresh_attempts_of_same_task', passed: observed.attempts.length === 2
      && Boolean(first?.taskId.trim()) && first.taskId === second?.taskId
      && Boolean(first.delegationId.trim() && second.delegationId.trim()) && first.delegationId !== second.delegationId },
    { key: 'native_call_budget_exhausted', passed: first?.maxIterations === 2 && first.modelCallCount === 2
      && observed.extraModelCallRequested && observed.blockedIteration === 3
      && first.guardStopReasons.includes('subagent_iteration_limit_reached') },
    { key: 'real_final_call_preserves_handoff', passed: Boolean(first?.delivery?.trim())
      && Boolean(first?.delivery?.includes('EVIDENCE-6429')) && observed.handoffTicketPreserved },
    { key: 'first_attempt_reads_but_does_not_verify', passed: reads.some(call => call.delegationId === first?.delegationId && call.success)
      && !verifies.some(call => call.delegationId === first?.delegationId) },
    { key: 'tool_calls_belong_to_actual_attempts', passed: observed.toolCalls.every(call =>
      observed.attempts.some(attempt => attempt.delegationId === call.delegationId)) },
    { key: 'paired_final_model_call_notice', passed: observed.notices.length === 1
      && observed.notices[0].reason === 'model_calls' && observed.notices[0].phase === 'finalize'
      && observed.notices[0].paired && observed.notices[0].delegationId === first?.delegationId },
    { key: 'fresh_attempt_receives_handoff_without_private_history', passed: observed.continuationInputs.length === 1
      && observed.continuationInputs[0].delegationId === second?.delegationId
      && observed.continuationInputs[0].hasPriorDelivery && !observed.continuationInputs[0].hasPrivateToolHistory },
    { key: 'continuation_performs_actual_verification', passed: verifies.some(call => call.success)
      && verifies.every(call => call.delegationId === second?.delegationId) },
    { key: 'continuation_finishes_within_fresh_budget', passed: second?.maxIterations === 4
      && second.modelCallCount >= 2 && second.modelCallCount <= second.maxIterations
      && second.guardStopReasons.length === 0 && Boolean(second.delivery?.trim()) },
    { key: 'final_facts', passed: observed.finalText.includes('EVIDENCE-6429') && observed.finalText.includes('VERIFY-3817') },
  ];
}

/**
 * Real child models and native budgets, with an eval-only extra re-entry request
 * after the second real response. The harness manually starts the fresh child;
 * it does not exercise or impersonate the Supervisor's retry decision.
 */
export async function runModelCallExhaustionCase(params: {
  input: { userMessage: string };
  model: AgentModels['act'];
  timeoutMs?: number;
}) {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(params.timeoutMs ?? 240_000)]);
  const usage = createPromptEvalUsageCollector();
  const taskId = `call-budget-task-${randomUUID()}`;
  const runId = `call-budget-run-${randomUUID()}`;
  const ticket = `ticket-${randomUUID()}`;
  const runtimeEvents: unknown[] = [];
  const observation: ModelCallExhaustionObservation = {
    attempts: [], toolCalls: [], notices: [], continuationInputs: [], extraModelCallRequested: false,
    blockedIteration: null, handoffTicketPreserved: false, finalText: '', invocationError: null,
  };
  let modelCallCount = 0;
  let activeDelegationId = '';
  const modelInputs = new Map<string, BaseMessage[][]>();
  const observer = BaseCallbackHandler.fromMethods({
    handleChatModelStart(_llm, batches) {
      modelCallCount++;
      if (modelCallCount > 8) controller.abort(new Error('Eval exceeded its eight-model-call safety bound.'));
      const inputs = modelInputs.get(activeDelegationId) ?? [];
      inputs.push(batches[0] ?? []);
      modelInputs.set(activeDelegationId, inputs);
    },
  });
  const scope = (runtime: ToolRuntime<unknown, SubagentRuntimeContext>) => {
    const delegationId = runtime.context.executionScope?.delegationId;
    if (!delegationId) throw new Error('Evidence tools require a child execution scope.');
    return delegationId;
  };
  const readEvidence = tool((_args, runtime: ToolRuntime<unknown, SubagentRuntimeContext>) => {
    observation.toolCalls.push({ name: 'read_evidence', delegationId: scope(runtime), success: true });
    return `Report fact: EVIDENCE-6429. Verification has not run. Verification ticket: ${ticket}. Use verify_evidence with this exact ticket to perform the required verification.`;
  }, { name: 'read_evidence', description: 'Read the requested synthetic evidence report and its opaque verification ticket.', schema: z.object({}) });
  const verifyEvidence = tool(({ ticket: received }, runtime: ToolRuntime<unknown, SubagentRuntimeContext>) => {
    const success = received === ticket && observation.toolCalls.some(call => call.name === 'read_evidence' && call.success);
    observation.toolCalls.push({ name: 'verify_evidence', delegationId: scope(runtime), success });
    return success ? 'Verification actually completed: VERIFY-3817. Evidence EVIDENCE-6429 is confirmed. No external resources were modified.'
      : 'Verification did not run: use the exact ticket returned by read_evidence.';
  }, { name: 'verify_evidence', description: 'Actually verify the evidence with the exact opaque ticket returned by read_evidence.', schema: z.object({ ticket: z.string() }) });
  const forceExtraReentry = createMiddleware({
    name: 'EvalRequestOneCallAfterExhaustion',
    afterModel: {
      canJumpTo: ['model'],
      hook: () => {
        // Observe completed real responses here; never modify or substitute the
        // native middleware's checkpointed counter.
        if (modelInputs.get(activeDelegationId)?.length === 2 && !observation.extraModelCallRequested) {
          observation.extraModelCallRequested = true;
          return { jumpTo: 'model' as const };
        }
      },
    },
  });
  // LangChain's terminal afterModel router exits immediately on a text answer.
  // An inert outer hook keeps the re-entry probe in the sequence router, where
  // its declared model jump is honored. Neither hook changes model messages.
  const reentryAnchor = createMiddleware({ name: 'EvalReentrySequenceAnchor', afterModel: () => undefined });
  const runAttempt = async (messages: BaseMessage[], maxIterations: number, forceReentry: boolean) => {
    const delegationId = `call-budget-attempt-${randomUUID()}`;
    activeDelegationId = delegationId;
    let result: SubagentResult | undefined;
    const checkpoint = new MemorySaver();
    const graph = new StateGraph(MessagesAnnotation).addNode('child', async (state, config) => {
      result = await createSubagent({
        model: params.model, tools: [readEvidence, verifyEvidence], messages: state.messages,
        promptSections: [{ id: 'capability:evidence', content: 'Complete the requested read-and-verify investigation. Ground findings in actual tool results. Verification requires a successful verify_evidence result. Preserve any opaque ticket needed by unfinished verification in your handoff.' }],
        maxIterations, middleware: forceReentry ? [reentryAnchor, forceExtraReentry] : [], runnableConfig: config,
        runtimeContext: { executionScope: { threadId: taskId, taskId, runId, delegationId } }, signal,
      });
      return { messages: result.messages };
    }).addEdge(START, 'child').addEdge('child', END).compile({ checkpointer: checkpoint });
    const config = { configurable: { thread_id: `${taskId}:${delegationId}` }, callbacks: [observer, usage.callback], signal };
    const run = await graph.streamEvents({ messages }, { ...config, version: 'v3' });
    for await (const event of run) {
      if (event.method !== 'custom') continue;
      const data = event.params.data;
      runtimeEvents.push(data);
      const record = data as { name?: string; data?: { iteration?: number; outcome?: { kind?: string } } };
      if (record.name === SUBAGENT_GUARD_DECISION_EVENT && record.data?.outcome?.kind === 'stop') {
        observation.blockedIteration = record.data.iteration ?? null;
      }
    }
    await run.output;
    if (!result) throw new Error('The child graph returned without a subagent result.');
    const completed = result as SubagentResult;
    const actualInputs = modelInputs.get(delegationId) ?? [];
    const persisted = new Set<string>();
    for await (const tuple of checkpoint.list({ configurable: config.configurable })) {
      const saved = tuple.checkpoint.channel_values.messages;
      if (!Array.isArray(saved)) continue;
      for (let index = 1; index < saved.length; index++) {
        const message = saved[index] as BaseMessage;
        const call = saved[index - 1] as BaseMessage;
        if (ToolMessage.isInstance(message) && message.name === 'runtime_budget_status'
          && AIMessage.isInstance(call) && call.tool_calls?.some(item => item.id === message.tool_call_id)) {
          persisted.add(message.id ?? message.tool_call_id);
        }
      }
    }
    const seen = new Set<string>();
    for (const input of actualInputs) for (let index = 1; index < input.length; index++) {
      const message = input[index];
      if (!ToolMessage.isInstance(message) || message.name !== 'runtime_budget_status') continue;
      const id = message.id ?? message.tool_call_id;
      if (seen.has(id)) continue;
      seen.add(id);
      const data = JSON.parse(message.text) as { reason: string; phase: string };
      const call = input[index - 1];
      observation.notices.push({ reason: data.reason, phase: data.phase, delegationId,
        paired: AIMessage.isInstance(call) && call.tool_calls?.some(item => item.id === message.tool_call_id) === true && persisted.has(id) });
    }
    observation.attempts.push({ taskId, delegationId, maxIterations, modelCallCount: actualInputs.length,
      delivery: completed.output, guardStopReasons: completed.messages.flatMap(message => {
        const reason = readSubagentGuardStopReason(message);
        return reason ? [reason] : [];
      }) });
    return { result: completed, firstInput: actualInputs[0] ?? [], delegationId };
  };
  try {
    const first = await runAttempt([new HumanMessage(params.input.userMessage)], 2, true);
    observation.handoffTicketPreserved = first.result.output?.includes(ticket) === true;
    const priorDelivery = new AIMessage({ id: `prior-delivery-${randomUUID()}`, content: first.result.output ?? '' });
    const second = await runAttempt([
      new HumanMessage(params.input.userMessage), priorDelivery,
      new HumanMessage('继续同一个任务。上方助手消息是上一轮实际交接内容。复用已获得的证据和 ticket，完成仍未执行的验证，再合并交付结果。'),
    ], 4, false);
    observation.continuationInputs.push({ delegationId: second.delegationId,
      hasPriorDelivery: Boolean(first.result.output?.trim()) && second.firstInput.some(message => message.id === priorDelivery.id && message.text === first.result.output),
      hasPrivateToolHistory: second.firstInput.some(message => ToolMessage.isInstance(message)
        ? ['read_evidence', 'verify_evidence', 'runtime_budget_status'].includes(message.name ?? '')
        : AIMessage.isInstance(message) && message.tool_calls?.some(call => ['read_evidence', 'verify_evidence', 'runtime_budget_status'].includes(call.name)) === true),
    });
    observation.finalText = second.result.output ?? '';
  } catch (error) {
    observation.invocationError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  return { observation, usage: usage.read(), diagnostics: {
    modelCallCount, completedDelegations: observation.attempts.length, runtimeEvents, expectedTicket: ticket,
    efficiency: {
      readCalls: observation.toolCalls.filter(call => call.name === 'read_evidence').length,
      repeatedReadCalls: Math.max(0, observation.toolCalls.filter(call => call.name === 'read_evidence').length - 1),
    },
    firstAttemptMaxIterations: 2, continuationMaxIterations: 4,
    boundary: 'The eval manually starts two real createSubagent invocations. Its afterModel probe requests one extra model entry after the first child completes two real calls. Native middleware blocks that entry; no response, counter or usage is fabricated. Supervisor scheduling is not exercised.',
  } };
}
