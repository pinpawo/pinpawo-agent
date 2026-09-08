import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { AIMessage } from '@langchain/core/messages';
import { createCapabilityDetailsDiagnosticsCollector } from './capability-planning-diagnostics.ts';

type Invocation = {
  id: string;
  kind: 'model' | 'tool';
  name: string;
  startMs: number;
  durationMs: number | null;
  status: 'pending' | 'completed' | 'error';
  proposedTools?: string[];
};

/** Eval-only timing; query/results remain owned by the existing search collector. */
export function createSupervisorDetailsDiagnostics(now = () => performance.now()) {
  const start = now();
  const calls = new Map<string, Invocation>();
  const search = createCapabilityDetailsDiagnosticsCollector();
  const begin = (id: string, kind: Invocation['kind'], name: string) => {
    calls.set(id, { id, kind, name, startMs: now() - start, durationMs: null, status: 'pending' });
  };
  const end = (id: string, status: 'completed' | 'error') => {
    const call = calls.get(id);
    if (call) { call.durationMs = now() - start - call.startMs; call.status = status; }
  };
  const callback = BaseCallbackHandler.fromMethods({
    handleChatModelStart(_model, _messages, id) { begin(id, 'model', 'chat_model'); },
    handleLLMEnd(output, id) {
      end(id, 'completed');
      const call = calls.get(id);
      if (call) call.proposedTools = output.generations.flatMap((batch) => batch.flatMap((generation) =>
        'message' in generation && AIMessage.isInstance(generation.message)
          ? (generation.message.tool_calls ?? []).map(({ name }) => name) : []));
    },
    handleLLMError(_error, id) { end(id, 'error'); },
    handleToolStart(tool, _input, id, _parent, _tags, _metadata, runName) {
      begin(id, 'tool', runName ?? tool.name ?? tool.id?.at(-1) ?? 'unknown');
    },
    handleToolEnd(_output, id) { end(id, 'completed'); },
    handleToolError(_error, id) { end(id, 'error'); },
  });
  return {
    callbacks: [search.callback, callback],
    read() {
      const invocations = [...calls.values()].map((call) => ({ ...call }));
      const diagnostics = search.read();
      const seen = new Set<string>();
      const repeatedQueries = diagnostics.detailRequests.filter((terms) => {
        const key = JSON.stringify([...terms].map((term) => term.trim().toLowerCase()).sort());
        if (seen.has(key)) return true;
        seen.add(key); return false;
      }).length;
      return { ...diagnostics, repeatedQueries, modelCalls: invocations.filter((call) => call.kind === 'model').length,
        elapsedMs: now() - start, invocations };
    },
  };
}
