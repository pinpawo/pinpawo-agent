import type {
  SubagentRuntimeEvent,
  SubagentToolEventHandler,
} from '../types/subagent';
import { NamespacedProtocolToolEventReader } from '../subagent/protocolToolEvents';

/**
 * Invoke-style graph consumption with the legacy `onToolEvent` vocabulary
 * reconstructed from the ROOT protocol stream (#322 Phase 4).
 *
 * `createSubagent()` no longer bridges its child stream through `onToolEvent`;
 * tool lifecycle and runtime events now surface natively on the root
 * `streamEvents(v3)` protocol stream. Invoke-style consumers (`runAgent`, the
 * Studio pet runtime) keep their `onToolEvent` contract: this helper drives
 * the run through `streamEvents` and translates
 *
 * - `tools` protocol events → tool lifecycle events (per-namespace readers:
 *   call ids are only unique within the scope that produced them);
 * - `custom` protocol events carrying the `on_runtime_event` envelope (guard
 *   decision records, `subagent_operations` announcements) → forwarded as-is.
 *
 * Without an `onToolEvent` handler it falls back to a plain `invoke()`.
 */

type ProtocolEventLike = {
  method: string;
  params: {
    namespace?: string[];
    data?: unknown;
  };
};

type RootRunStream = AsyncIterable<ProtocolEventLike> & {
  output: Promise<unknown>;
  interrupts: unknown[];
};

type RootStreamCapableGraph = {
  invoke(input: unknown, options?: Record<string, unknown>): Promise<unknown>;
  streamEvents(input: unknown, options?: Record<string, unknown>): Promise<unknown> | unknown;
};

function readRuntimeEvent(data: unknown): SubagentRuntimeEvent | null {
  if (
    data
    && typeof data === 'object'
    && (data as { event?: unknown }).event === 'on_runtime_event'
    && typeof (data as { name?: unknown }).name === 'string'
  ) {
    return data as SubagentRuntimeEvent;
  }
  return null;
}

/**
 * `invoke()` result parity: an interrupted run reports the pending interrupts
 * under `__interrupt__` on the result object, which is how invoke-style
 * consumers (Studio's human reviewer loop) detect HITL pauses.
 */
function withInterrupts(output: unknown, interrupts: unknown[]): unknown {
  if (interrupts.length === 0) {
    return output;
  }
  const record = output && typeof output === 'object' ? output : {};
  if ('__interrupt__' in record) {
    return record;
  }
  return { ...record, __interrupt__: interrupts };
}

export async function invokeWithRootStreamToolEvents(
  graph: RootStreamCapableGraph,
  input: unknown,
  options: Record<string, unknown>,
  onToolEvent?: SubagentToolEventHandler,
): Promise<unknown> {
  if (!onToolEvent) {
    return await graph.invoke(input, options);
  }

  const run = await graph.streamEvents(input, {
    ...options,
    version: 'v3',
  }) as RootRunStream;

  const toolReader = new NamespacedProtocolToolEventReader();
  for await (const event of run) {
    if (event.method === 'tools') {
      const lifecycle = toolReader.readToolsData(event.params.namespace, event.params.data);
      if (lifecycle) {
        await onToolEvent(lifecycle);
      }
      continue;
    }
    if (event.method === 'custom') {
      const runtimeEvent = readRuntimeEvent(event.params.data);
      if (runtimeEvent) {
        await onToolEvent(runtimeEvent);
      }
    }
  }

  return withInterrupts(await run.output, run.interrupts);
}
