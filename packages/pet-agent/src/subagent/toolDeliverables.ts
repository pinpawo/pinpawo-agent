import { assertToolDeliverables, type Deliverable } from '@pinpawo/agent-contracts';
import { ToolMessage } from '@langchain/core/messages';
import type { StructuredTool } from '@langchain/core/tools';
import { Command, isCommand, ReducedValue, StateSchema } from '@langchain/langgraph';
import { createMiddleware, type AnyAgentMiddleware } from 'langchain';
import { z } from 'zod/v4';

const deliverableSchema = z.object({
  uri: z.string().refine(uri => uri.trim().length > 0),
  title: z.string().optional(),
}).passthrough();
const deliverablesSchema = z.array(deliverableSchema).default([]);

function mergeDeliverables(current: Deliverable[], incoming: Deliverable[]): Deliverable[] {
  const uris = new Set(current.map(value => value.uri));
  const merged = [...current];
  for (const value of incoming) {
    if (uris.has(value.uri)) continue;
    uris.add(value.uri);
    merged.push(value);
  }
  return merged;
}

function readMessageDeliverables(value: unknown): Deliverable[] {
  const messages = Array.isArray(value) ? value : [value];
  return messages.flatMap(message => {
    if (!ToolMessage.isInstance(message)) return [];
    const artifact = message.artifact;
    if (!artifact || typeof artifact !== 'object' || !('deliverables' in artifact)) return [];
    assertToolDeliverables(artifact);
    return artifact.deliverables;
  });
}

function collectToolResult<T>(result: T): T | Command {
  if (ToolMessage.isInstance(result)) {
    const deliverables = readMessageDeliverables(result);
    return deliverables.length ? new Command({ update: { messages: [result], deliverables } }) : result;
  }
  if (!isCommand(result)) return result;
  // Cross-graph commands transfer control outside this Capability's state. Keep
  // them unchanged rather than writing child-only fields into the target graph.
  // Their declarations are not inspected or collected by this child collector.
  if (result.graph) return result;
  const update = result.update;
  const entries = Array.isArray(update) ? update : Object.entries(update ?? {});
  const deliverables = entries.flatMap(([key, value]) => key === 'messages' ? readMessageDeliverables(value) : []);
  if (!deliverables.length) return result;
  const nextUpdate = Array.isArray(update)
    ? [...entries, ['deliverables', deliverables] as [string, unknown]]
    : { ...update, deliverables };
  return new Command({ ...result, update: nextUpdate });
}

function adaptTool<T>(source: T): T {
  if (!source || typeof source !== 'object' || !('invoke' in source) || typeof source.invoke !== 'function') return source;
  const invoke = source.invoke;
  return Object.create(source, {
    invoke: { configurable: true, writable: true, value: async (...args: unknown[]) =>
      collectToolResult(await invoke.apply(source, args)) },
  }) as T;
}

/** Capture tool outputs in the same checkpoint update as their ToolMessages. */
export function createToolDeliverablesCollector(
  tools: readonly StructuredTool[],
  existingMiddleware: readonly AnyAgentMiddleware[],
): { tools: StructuredTool[]; middleware: AnyAgentMiddleware; toolMiddleware: AnyAgentMiddleware[] } {
  const stateSchema = new StateSchema({
    deliverables: new ReducedValue<Deliverable[], Deliverable[]>(deliverablesSchema as never, {
      inputSchema: deliverablesSchema as never,
      reducer: mergeDeliverables,
    }),
  });
  // Adding the first wrapToolCall changes LangChain's default tool-error policy.
  // With no existing wrapper, adapt only successful tool outputs and let the
  // original ToolNode continue handling errors, aborts and interrupts.
  if (!existingMiddleware.some(middleware => middleware.wrapToolCall)) {
    return {
      tools: tools.map(adaptTool),
      toolMiddleware: existingMiddleware.map(middleware => middleware.tools?.length
        ? Object.create(middleware, { tools: { value: middleware.tools.map(adaptTool) } }) as AnyAgentMiddleware
        : middleware),
      middleware: createMiddleware({ name: 'ToolDeliverables', stateSchema }),
    };
  }
  // An existing wrapper already owns that policy. Observe its final result so
  // overridden tools and synthetic ToolMessages are collected as well.
  return {
    tools: [...tools],
    toolMiddleware: [...existingMiddleware],
    middleware: createMiddleware({
      name: 'ToolDeliverables', stateSchema,
      wrapToolCall: async (request, handler) => collectToolResult(await handler(request)),
    }),
  };
}
