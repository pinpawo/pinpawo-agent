import { createHash, randomUUID } from 'node:crypto';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { tool, type ToolRuntime } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import { countTokensApproximately } from 'langchain';
import { z } from 'zod';
import { createOrchestratorGraph } from '../../../packages/pet-agent/src/agent/orchestrator/runtime/graph.ts';
import { buildOrchestratorRunInput, type OrchestratorStateType } from '../../../packages/pet-agent/src/agent/orchestrator/state.ts';
import { compileAgentRegistry } from '../../../packages/pet-agent/src/agent/orchestrator/registry.ts';
import { readCapabilityExecutions } from '../../../packages/pet-agent/src/agent/orchestrator/executionMessages.ts';
import { getAgentMessageMetadata } from '../../../packages/pet-agent/src/agent/messages/metadata.ts';
import { defineToolkit } from '../../../packages/pet-agent/src/types/toolkit.ts';
import { defineInstructionDocument } from '../../../packages/pet-agent/src/types/capability.ts';
import type { SubagentRuntimeContext } from '../../../packages/pet-agent/src/types/subagent.ts';
import type { AgentModels } from '../../../packages/pet-agent/src/types/agent.ts';
import { readSubagentGuardStopReason } from '../../../packages/pet-agent/src/subagent/guardStop.ts';
import { createPromptEvalUsageCollector, readLlmResultTokenUsage } from './prompt-eval-usage.ts';
import type { BudgetHandoffInput, BudgetHandoffExpected } from './datasets/budget-handoff.ts';

export type BudgetHandoffObservation = {
  executions: Array<{ taskId: string; planItemId: string; delegationId: string; status: string; delivery: string | null }>;
  toolCalls: Array<{ name: string; delegationId: string; success: boolean }>;
  notices: Array<{ reason: string; phase: string; paired: boolean; delegationId: string | null }>;
  continuationInputs: Array<{ delegationId: string; hasPriorResult: boolean; hasPriorDelivery: boolean; hasPrivateToolHistory: boolean }>;
  guardStops: Array<{ reason: string; delegationId: string | null }>;
  childModelCalls: Array<{ delegationId: string; count: number }>;
  planCompleted: boolean;
  finalText: string;
  invocationError: string | null;
  verbatimEvidence?: { source: string; text: string };
};

function preservesVerbatimText(candidate: string | null | undefined, original: string): boolean {
  if (!candidate || !original) return false;
  // Markdown blockquote markers are presentation syntax. Remove only that
  // prefix, leaving the quoted text's punctuation and internal whitespace.
  return candidate.includes(original)
    || candidate.split('\n').map(line => line.replace(/^ {0,3}> ?/, '')).join('\n').includes(original);
}

export function evaluateBudgetHandoffInvariants(
  observed: BudgetHandoffObservation,
  expected: Pick<BudgetHandoffExpected, 'expectedDelegations' | 'contextHandoff' | 'contextOverflow' | 'verbatimResult'>,
) {
  const executions = observed.executions;
  const reads = observed.toolCalls.filter(call => call.name === 'read_evidence' && call.success);
  const verifications = observed.toolCalls.filter(call => call.name === 'verify_evidence' && call.success);
  const first = executions[0];
  const overflow = expected.contextOverflow === true;
  const continues = expected.contextHandoff || overflow;
  const checks = [
    { key: 'invocation_succeeded', passed: observed.invocationError === null },
    { key: 'expected_delegation_count', passed: executions.length === expected.expectedDelegations },
    { key: 'expected_delivery_statuses', passed: executions.length > 0 && executions.every((item, index) => overflow && index === 0
      ? item.status === 'missing_deliverable' && item.delivery === null
      : item.status === 'returned' && Boolean(item.delivery?.trim())) },
    { key: 'same_task_and_plan', passed: Boolean(first?.taskId.trim() && first.planItemId.trim())
      && executions.every(item => item.taskId === first.taskId && item.planItemId === first.planItemId) },
    { key: 'fresh_delegations', passed: executions.every(item => Boolean(item.delegationId.trim()))
      && new Set(executions.map(item => item.delegationId)).size === executions.length },
    { key: 'actual_evidence_and_verification', passed: reads.length === (overflow ? 2 : 1) && verifications.length === 1 },
    { key: 'verification_in_expected_attempt', passed: reads.length === (overflow ? 2 : 1) && verifications.length === 1
      && reads[0].delegationId === first?.delegationId
      && (!overflow || reads[1].delegationId === executions[1]?.delegationId)
      && verifications[0].delegationId === executions[continues ? 1 : 0]?.delegationId },
    { key: 'context_notice', passed: expected.contextHandoff
      ? observed.notices.length === 1 && observed.notices[0].reason === 'context_window' && observed.notices[0].phase === 'finalize'
        && observed.notices[0].paired && observed.notices[0].delegationId === first?.delegationId
      : observed.notices.length === 0 },
    { key: 'expected_hard_stop', passed: overflow
      ? observed.guardStops.length === 1 && observed.guardStops[0].reason === 'subagent_context_limit_reached'
        && observed.guardStops[0].delegationId === first?.delegationId
      : observed.guardStops.length === 0 },
    { key: 'no_provider_request_after_overflow', passed: !overflow
      || observed.childModelCalls.find(item => item.delegationId === first?.delegationId)?.count === 1 },
    { key: 'continuation_sees_delivery_not_private_history', passed: !continues
      || observed.continuationInputs.some(item => item.delegationId === executions[1]?.delegationId
        && item.hasPriorResult && (overflow ? !item.hasPriorDelivery : item.hasPriorDelivery) && !item.hasPrivateToolHistory) },
    { key: 'plan_accepted', passed: observed.planCompleted },
    { key: 'final_facts', passed: observed.finalText.includes('EVIDENCE-6429') && observed.finalText.includes('VERIFY-3817') },
  ];
  if (expected.verbatimResult !== undefined) {
    checks.push(
      { key: 'verbatim_source_observed', passed: Boolean(expected.verbatimResult)
        && observed.verbatimEvidence?.text === expected.verbatimResult
        && observed.verbatimEvidence.source === 'evidence-fixture.ts' },
      { key: 'first_delivery_preserves_original', passed: preservesVerbatimText(first?.delivery, expected.verbatimResult) },
      { key: 'final_reply_preserves_original', passed: preservesVerbatimText(observed.finalText, expected.verbatimResult) },
    );
  }
  return checks;
}

type ModelInput = { group: string; messages: BaseMessage[]; inputTokens: number; providerInputTokens: number | null };

export function readCheckpointGuardStops(messages: BaseMessage[], toolResultDelegations: ReadonlyMap<string, string>) {
  const privateTool = [...messages].reverse().find(message => ToolMessage.isInstance(message)
    && message.id && toolResultDelegations.has(message.id));
  const delegationId = privateTool?.id ? toolResultDelegations.get(privateTool.id)! : null;
  return messages.flatMap(message => {
    const reason = readSubagentGuardStopReason(message);
    return reason ? [{ id: message.id!, reason, delegationId }] : [];
  });
}

/** All models and orchestration are real; only the evidence environment is synthetic. */
export async function runBudgetHandoffCase(params: {
  input: BudgetHandoffInput;
  model: AgentModels['act'];
  timeoutMs?: number;
}) {
  const { input, model } = params;
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(params.timeoutMs ?? 240_000)]);
  const usage = createPromptEvalUsageCollector();
  const ticket = `ticket-${randomUUID()}`;
  const toolCalls: BudgetHandoffObservation['toolCalls'] = [];
  const modelInputs: ModelInput[] = [];
  const runInputs = new Map<string, ModelInput>();
  const groupDelegations = new Map<string, string>();
  const toolResultDelegations = new Map<string, string>();
  let latestInput: ModelInput | null = null;
  let modelCallCount = 0;
  let completedDelegations = 0;
  let verbatimEvidence: BudgetHandoffObservation['verbatimEvidence'];
  const scope = (runtime: ToolRuntime<unknown, SubagentRuntimeContext>) => {
    const delegationId = runtime.context.executionScope?.delegationId;
    if (!delegationId) throw new Error('Synthetic evidence tools require the real Capability execution scope.');
    if (latestInput) groupDelegations.set(latestInput.group, delegationId);
    return delegationId;
  };
  const toolResult = (name: string, content: string, runtime: ToolRuntime<unknown, SubagentRuntimeContext>) => {
    // Provider tool-call IDs need only be unique inside one response. Give
    // fixture results stable unique IDs so fresh attempts cannot overwrite
    // the checkpoint-to-delegation association when those call IDs repeat.
    const result = new ToolMessage({ id: `budget-evidence-${randomUUID()}`,
      name, content, tool_call_id: runtime.toolCallId });
    toolResultDelegations.set(result.id!, scope(runtime));
    return result;
  };
  const readEvidence = tool((_args, runtime: ToolRuntime<unknown, SubagentRuntimeContext>) => {
    toolCalls.push({ name: 'read_evidence', delegationId: scope(runtime), success: true });
    let header = `Evidence fact: EVIDENCE-6429. The report identifies a reproducible fixture defect; verification has not yet run.\nVerification ticket: ${ticket}\nThe next required operation is verify_evidence with this ticket.\n`;
    if (input.requiredVerbatimText !== undefined) {
      verbatimEvidence = { source: 'evidence-fixture.ts', text: input.requiredVerbatimText };
      header += `Diagnostic source: ${verbatimEvidence.source}\nOriginal diagnostic:\n${verbatimEvidence.text}\nEnd original diagnostic.\n`;
    }
    const latest = latestInput;
    if (!latest) throw new Error('No actual model input was observed before reading evidence.');
    // Exercise the production watermark with a scaled logical window rather
    // than spending a provider's million-token window on artificial padding.
    const baseline = Math.max(latest.inputTokens, latest.providerInputTokens ?? 0);
    const overflow = input.scenario === 'context-overflow';
    const firstRead = toolCalls.filter(call => call.name === 'read_evidence').length === 1;
    const targetTokens = Math.floor(input.contextWindowTokens * (overflow ? 1 : 0.85))
      - input.generationReserveTokens + (overflow ? 400 : 200);
    // A fresh attempt can reread a bounded report; private findings from the
    // failed attempt are intentionally not promoted into a made-up delivery.
    const reportCap = overflow && !firstRead ? 1_600 : input.reportChars;
    const targetChars = Math.min(reportCap, Math.max(header.length, (targetTokens - baseline) * 4));
    const row = 'Synthetic evidence sample: source=fixture; observation=stable; mutation=none.\n';
    return toolResult('read_evidence', header + row.repeat(Math.ceil(targetChars / row.length))
      .slice(0, Math.max(0, targetChars - header.length)), runtime);
  }, { name: 'read_evidence', description: 'Read the requested synthetic report and its opaque verification ticket.', schema: z.object({}) });
  const verifyEvidence = tool(({ ticket: received }, runtime: ToolRuntime<unknown, SubagentRuntimeContext>) => {
    const success = received === ticket && toolCalls.some(call => call.name === 'read_evidence' && call.success);
    toolCalls.push({ name: 'verify_evidence', delegationId: scope(runtime), success });
    return toolResult('verify_evidence', success
      ? 'Verification actually completed: VERIFY-3817. Evidence EVIDENCE-6429 is confirmed. No external resources were modified.'
      : 'Verification did not run: use the exact ticket returned by read_evidence.', runtime);
  }, { name: 'verify_evidence', description: 'Actually verify the evidence using the opaque ticket returned by read_evidence.', schema: z.object({ ticket: z.string() }) });
  const tools = [readEvidence, verifyEvidence];
  const observer = BaseCallbackHandler.fromMethods({
    handleChatModelStart(_llm, batches, runId) {
      modelCallCount++;
      if (modelCallCount > 20) controller.abort(new Error('Eval exceeded its 20-model-call safety bound.'));
      const messages = batches[0] ?? [];
      const system = messages.filter(message => message._getType() === 'system').map(message => message.content);
      const group = createHash('sha256').update(JSON.stringify(system)).digest('hex');
      const entry: ModelInput = { group, messages, inputTokens: countTokensApproximately(messages, tools), providerInputTokens: null };
      modelInputs.push(entry);
      runInputs.set(runId, entry);
      latestInput = entry;
    },
    handleLLMEnd(output, runId) {
      const entry = runInputs.get(runId);
      if (entry) entry.providerInputTokens = readLlmResultTokenUsage(output)?.inputTokens ?? null;
    },
  });
  const toolkit = defineToolkit({ name: 'budget_evidence', description: 'Read and verify synthetic evidence without external side effects.', tools: tools.map(item => ({ tool: item })) });
  const registry = compileAgentRegistry({ toolkits: [toolkit], capabilities: [{
    name: 'general', description: 'Read reports and verify their evidence in one investigation.', uses: ['budget_evidence'],
    instructions: defineInstructionDocument({ content: 'Complete the requested evidence investigation with the provided tools. Ground conclusions in their actual results. Do not claim verification before the verification tool succeeds.' }),
  }] });
  const checkpoint = new MemorySaver();
  const graph = createOrchestratorGraph({
    models: { act: model, answer: model, subagent: model }, checkpoint,
    subagentContextWindowTokens: input.contextWindowTokens,
    subagentGenerationReserveTokens: input.generationReserveTokens,
  });
  const config = { configurable: { thread_id: `budget-eval-${randomUUID()}`, registry,
    onDelegationComplete: () => {
      completedDelegations++;
      if (completedDelegations >= 4) throw new Error('Eval exceeded its four-delegation safety bound.');
    },
  }, callbacks: [observer, usage.callback], signal,
  };
  let output: OrchestratorStateType | null = null;
  let invocationError: string | null = null;
  const runtimeEvents: unknown[] = [];
  try {
    const run = await graph.streamEvents(buildOrchestratorRunInput([new HumanMessage(input.userMessage)]), { ...config, version: 'v3' });
    for await (const event of run) if (event.method === 'custom') runtimeEvents.push(event.params.data);
    output = await run.output as OrchestratorStateType;
  } catch (error) {
    invocationError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    output = (await graph.getState({ configurable: config.configurable })).values as OrchestratorStateType;
  }
  const executions = readCapabilityExecutions(output?.messages ?? []).map(({ metadata, execution, result }) => ({
    taskId: typeof metadata.taskId === 'string' ? metadata.taskId : '', planItemId: execution.planItemId, delegationId: execution.delegationId,
    status: result.status, delivery: result.delivery?.text ?? null,
  }));
  const notices = new Map<string, BudgetHandoffObservation['notices'][number]>();
  const persistedNoticeIds = new Set<string>();
  const guardStops = new Map<string, BudgetHandoffObservation['guardStops'][number]>();
  for await (const tuple of checkpoint.list(config)) {
    const messages = tuple.checkpoint.channel_values.messages;
    if (!Array.isArray(messages)) continue;
    for (const { id, reason, delegationId } of readCheckpointGuardStops(messages, toolResultDelegations)) {
      guardStops.set(id, { reason, delegationId });
    }
    for (let index = 1; index < messages.length; index++) {
      const message = messages[index] as BaseMessage;
      const call = messages[index - 1] as BaseMessage;
      if (ToolMessage.isInstance(message) && message.name === 'runtime_budget_status'
        && AIMessage.isInstance(call) && call.tool_calls?.some(item => item.id === message.tool_call_id)) {
        persistedNoticeIds.add(message.id ?? message.tool_call_id);
      }
    }
  }
  for (const recorded of modelInputs) {
    for (let index = 0; index < recorded.messages.length; index++) {
      const message = recorded.messages[index];
      if (!ToolMessage.isInstance(message) || message.name !== 'runtime_budget_status') continue;
      const data = JSON.parse(message.text) as { reason: string; phase: string };
      const call = recorded.messages[index - 1];
      const delegationId = executions.find(item => message.id?.includes(item.delegationId))?.delegationId ?? null;
      notices.set(message.id ?? message.tool_call_id, { reason: data.reason, phase: data.phase, delegationId,
        paired: AIMessage.isInstance(call) && call.tool_calls?.some(item => item.id === message.tool_call_id) === true
          && persistedNoticeIds.has(message.id ?? message.tool_call_id) });
    }
  }
  const firstInputs = new Map<string, ModelInput>();
  for (const entry of modelInputs) if (groupDelegations.has(entry.group) && !firstInputs.has(entry.group)) firstInputs.set(entry.group, entry);
  const continuationInputs = [...firstInputs.values()].map(entry => {
    const priorResults = readCapabilityExecutions(entry.messages);
    return {
      delegationId: groupDelegations.get(entry.group)!,
      hasPriorResult: priorResults.length > 0,
      hasPriorDelivery: priorResults.some(({ result }) => result.status === 'returned' && Boolean(result.delivery?.text.trim())),
      hasPrivateToolHistory: entry.messages.some(message => ToolMessage.isInstance(message) && ['read_evidence', 'verify_evidence', 'runtime_budget_status'].includes(message.name ?? '')),
    };
  });
  const finalText = (output?.messages ?? []).filter(message => AIMessage.isInstance(message)
    && !getAgentMessageMetadata(message).lane && !message.tool_calls?.length).at(-1)?.text ?? '';
  const observation: BudgetHandoffObservation = {
    executions, toolCalls, notices: [...notices.values()], continuationInputs, finalText, invocationError,
    guardStops: [...guardStops.values()],
    childModelCalls: [...groupDelegations].map(([group, delegationId]) => ({
      delegationId, count: modelInputs.filter(entry => entry.group === group).length,
    })),
    planCompleted: Boolean(output?.runSupervisorState.plan.length) && output!.runSupervisorState.plan.every(item => item.status === 'completed'),
    ...(verbatimEvidence ? { verbatimEvidence } : {}),
  };
  return { observation, usage: usage.read(), diagnostics: { modelCallCount, completedDelegations, runtimeEvents, expectedTicket: ticket,
    logicalWindowTokens: input.contextWindowTokens, generationReserveTokens: input.generationReserveTokens, maxReportChars: input.reportChars,
    actualInputEstimates: modelInputs.map(entry => ({ group: entry.group, inputTokens: entry.inputTokens, providerInputTokens: entry.providerInputTokens })) } };
}
