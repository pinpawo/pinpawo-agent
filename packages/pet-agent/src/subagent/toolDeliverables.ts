import { assertToolDeliverables, readToolDeliverables, type Deliverable } from '@pinpawo/agent-contracts';
import { ToolMessage } from '@langchain/core/messages';
import type { StructuredTool } from '@langchain/core/tools';
import { Command, isCommand } from '@langchain/langgraph';
import { registry } from '@langchain/langgraph/zod';
import { createMiddleware, type AnyAgentMiddleware } from 'langchain';
import { z } from 'zod/v4';

const references = z.custom<Deliverable[]>((value) => {
  assertToolDeliverables({ deliverables: value });
  return true;
}).default(() => []);

function mergeReferences(previous: Deliverable[], incoming: Deliverable[] = []): Deliverable[] {
  const uris = new Set(previous.map(reference => reference.uri));
  const result = [...previous];
  for (const reference of incoming) {
    if (uris.has(reference.uri)) continue;
    uris.add(reference.uri);
    result.push(reference);
  }
  return result;
}

function messageReferences(value: unknown): Deliverable[] {
  return (Array.isArray(value) ? value : [value]).flatMap(message =>
    ToolMessage.isInstance(message) ? readToolDeliverables(message.artifact) : []);
}

/** Keep references and their tool result in the same child-graph checkpoint update. */
function collectResult<T>(result: T): T | Command {
  if (ToolMessage.isInstance(result)) {
    const deliverables = messageReferences(result);
    return deliverables.length ? new Command({ update: { messages: [result], deliverables } }) : result;
  }
  if (!isCommand(result) || result.graph) return result;
  // Cross-graph Commands leave this Capability's state and pass through unchanged.
  const entries = Array.isArray(result.update) ? result.update : Object.entries(result.update ?? {});
  const deliverables = entries.flatMap(([key, value]) => key === 'messages' ? messageReferences(value) : []);
  if (!deliverables.length) return result;
  return new Command({ ...result, update: Array.isArray(result.update)
    ? [...entries, ['deliverables', deliverables]] : { ...result.update, deliverables } });
}

function adaptSuccessfulResult<T>(source: T): T {
  if (!source || typeof source !== 'object' || !('invoke' in source) || typeof source.invoke !== 'function') return source;
  const invoke = source.invoke;
  return Object.create(source, {
    invoke: { value: async (...args: unknown[]) => collectResult(await invoke.apply(source, args)) },
  }) as T;
}

export function createToolDeliverablesCollector(
  tools: readonly StructuredTool[],
  middleware: readonly AnyAgentMiddleware[],
): { tools: StructuredTool[]; state: AnyAgentMiddleware; middleware: AnyAgentMiddleware[] } {
  const stateSchema = z.object({
    deliverables: references.register(registry, { reducer: { fn: mergeReferences }, default: () => [] }),
  });
  // Adding the first wrapToolCall changes LangChain's ordinary-error handling.
  // Adapt successful invokes only, so its existing interrupt/abort/error path stays in charge.
  if (!middleware.some(value => value.wrapToolCall)) return {
    tools: tools.map(adaptSuccessfulResult),
    middleware: middleware.map(value => value.tools?.length
      ? Object.create(value, { tools: { value: value.tools.map(adaptSuccessfulResult) } }) as AnyAgentMiddleware
      : value),
    state: createMiddleware({ name: 'ToolDeliverables', stateSchema }),
  };
  // An existing wrapper already owns that policy, including overridden tools and synthetic results.
  return {
    tools: [...tools],
    middleware: [...middleware],
    state: createMiddleware({ name: 'ToolDeliverables', stateSchema,
      wrapToolCall: async (request, handler) => collectResult(await handler(request)),
    }),
  };
}
