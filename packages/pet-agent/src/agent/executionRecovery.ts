import type { RunScope } from '../types/scope';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { OrchestratorGraph } from './orchestrator/runtime/graph';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { buildOrchestratorRunInput, type BuildOrchestratorRunOptions } from './orchestrator/state';
import { readPendingInterrupt, type PendingInterrupt } from './orchestrator/interrupt';

/** Public runtime identities: independent of Host invocation and protocol request IDs. */
export type RuntimeExecutionIdentity = RunScope & { threadId: string };
export type RuntimeRecoveryDescriptor = {
  identity: RuntimeExecutionIdentity | null;
  state: 'empty' | 'waiting' | 'completed' | 'failed' | 'unknown';
  pendingInterrupt: PendingInterrupt | null;
  reply?: string; error?: string;
};

/** Allocate inside runtime. A Host may persist the public identity before starting the returned input. */
export function prepareRuntimeExecution(messages: BaseMessage[], threadId: string, options: BuildOrchestratorRunOptions = {}) {
  const input = buildOrchestratorRunInput(messages, options);
  return { input, identity: { threadId, taskId: input.taskId, runId: input.runId } };
}

/** Runtime-owned adaptation of its checkpoint; callers only receive a typed descriptor. */
export function readRuntimeRecoveryDescriptor(snapshot: unknown, threadId: string): RuntimeRecoveryDescriptor {
  const state = snapshot as { values?: { runId?: unknown; taskId?: unknown; messages?: BaseMessage[]; runTerminalError?: { message?: string } }; next?: unknown[]; tasks?: unknown[] };
  const values = state?.values;
  const identity = typeof values?.runId === 'string' && values.runId && typeof values.taskId === 'string' && values.taskId
    ? { threadId, taskId: values.taskId, runId: values.runId } : null;
  const pendingInterrupt = readPendingInterrupt(snapshot);
  if (!identity) return { identity: null, state: pendingInterrupt ? 'unknown' : 'empty', pendingInterrupt };
  if (pendingInterrupt) return { identity, state: 'waiting', pendingInterrupt };
  if (values?.runTerminalError) return { identity, state: 'failed', pendingInterrupt: null, error: values.runTerminalError.message ?? 'Runtime failed.' };
  if (state.next?.length || state.tasks?.length) return { identity, state: 'unknown', pendingInterrupt: null };
  const last = values?.messages?.at(-1);
  const metadata = last?.additional_kwargs?.pinpawo as Record<string, unknown> | undefined;
  if (!last || !AIMessage.isInstance(last) || last.tool_calls?.length || metadata?.lane || metadata?.synthetic) {
    return { identity, state: 'unknown', pendingInterrupt: null };
  }
  return { identity, state: 'completed', pendingInterrupt: null, reply: last.text };
}

/** Public recovery query. Runtime, rather than Host business code, owns state reads. */
export async function readRuntimeExecutionRecovery(graph: Pick<OrchestratorGraph, 'getState'>, config: RunnableConfig, threadId: string): Promise<RuntimeRecoveryDescriptor> {
  return readRuntimeRecoveryDescriptor(await graph.getState(config), threadId);
}
