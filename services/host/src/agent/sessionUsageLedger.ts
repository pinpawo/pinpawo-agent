import { randomUUID } from 'node:crypto';
import type { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { parseTokenUsageSnapshot, readMessageTokenUsage, readMessagesTokenUsage, type TokenUsageSnapshot } from '@pinpawo/pet-agent';

export type UsageCall = {
  usage?: TokenUsageSnapshot;
  pending?: boolean;
  state?: 'completed' | 'failed';
};
export type SessionUsageLedger = {
  version: 1;
  revision?: number;
  epoch?: string;
  baseline?: TokenUsageSnapshot;
  calls: Record<string, UsageCall>;
  latestCallId?: string;
  /** Checkpointers without a usage store retain live accounting in memory only. */
  transient?: boolean;
};
export interface SessionUsageStore {
  readSessionUsage(threadId: string): SessionUsageLedger | null;
  putSessionUsageCall(threadId: string, id: string, call: UsageCall, baseline?: TokenUsageSnapshot): Promise<void>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function parseSessionUsageLedger(value: unknown): SessionUsageLedger {
  const root = record(value);
  const calls = record(root?.calls);
  if (root?.version !== 1 || !calls
    || (root.revision !== undefined && (!Number.isSafeInteger(root.revision) || Number(root.revision) < 0))
    || (root.latestCallId !== undefined && (typeof root.latestCallId !== 'string' || !Object.hasOwn(calls, root.latestCallId)))) {
    throw new Error('Invalid session usage ledger');
  }
  if (root.epoch !== undefined && (typeof root.epoch !== 'string' || !root.epoch.trim())) throw new Error('Invalid session usage epoch');
  const baseline = root.baseline === undefined ? undefined : parseTokenUsageSnapshot(root.baseline);
  if (baseline === null) throw new Error('Invalid session usage baseline');
  const parsedCalls = Object.fromEntries(Object.entries(calls).map(([id, value]) => {
    const call = record(value);
    const usage = call?.usage === undefined ? undefined : parseTokenUsageSnapshot(call.usage);
    if (!id || !call || usage === null
      || (call.pending !== undefined && typeof call.pending !== 'boolean')
      || (call.state !== undefined && call.state !== 'completed' && call.state !== 'failed')) {
      throw new Error('Invalid session usage call');
    }
    return [id, { ...(usage ? { usage } : {}), ...(call.pending ? { pending: true } : {}),
      ...(call.state ? { state: call.state } : {}) }];
  }));
  return { version: 1, calls: parsedCalls,
    ...(baseline ? { baseline } : {}),
    ...(typeof root.epoch === 'string' ? { epoch: root.epoch } : {}),
    ...(root.revision !== undefined ? { revision: root.revision as number } : {}),
    ...(root.latestCallId !== undefined ? { latestCallId: root.latestCallId as string } : {}),
    ...(root.transient === true ? { transient: true } : {}) } as SessionUsageLedger;
}

/** Shared reconciliation for durable and in-memory stores. Final reports are immutable. */
export function updateSessionUsageLedger(
  existing: SessionUsageLedger | null, id: string, call: UsageCall, baseline?: TokenUsageSnapshot,
): SessionUsageLedger {
  const ledger = existing ?? { version: 1 as const, ...(baseline ? { baseline } : {}), calls: {} };
  const previous = Object.hasOwn(ledger.calls, id) ? ledger.calls[id] : undefined;
  const completed = previous?.state === 'completed'
    || (previous?.state === undefined && !previous?.pending && previous?.usage && !previous.usage.incomplete);
  if (completed || (previous && !previous.pending && call.pending)
    || (previous?.pending && call.pending && !call.usage)) return ledger;
  return { ...ledger, epoch: ledger.epoch ?? randomUUID(), calls: { ...ledger.calls, [id]: call },
    revision: (ledger.revision ?? 0) + 1, latestCallId: id };
}

export function createTransientSessionUsageStore(): SessionUsageStore {
  const ledgers = new Map<string, SessionUsageLedger>();
  return {
    readSessionUsage: id => ledgers.get(id) ?? null,
    async putSessionUsageCall(threadId, id, call, baseline) {
      const ledger = updateSessionUsageLedger(ledgers.get(threadId) ?? null, id, call, baseline);
      ledgers.set(threadId, { ...ledger, transient: true });
    },
  };
}

/** Absolute snapshots replace totals on replay, never increment them. */
export function summarizeSessionUsage(ledger: SessionUsageLedger): TokenUsageSnapshot {
  const usages = [ledger.baseline, ...Object.values(ledger.calls).map(call => call.usage)]
    .filter((usage): usage is TokenUsageSnapshot => !!usage);
  const total = readMessagesTokenUsage(usages.map(usage => ({ usage_metadata: usage })))
    ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const unknownCalls = Object.values(ledger.calls).filter(call => !call.usage || call.pending || call.usage.incomplete).length;
  const latest = ledger.latestCallId ? ledger.calls[ledger.latestCallId]?.usage : usages.at(-1);
  return { ...total,
    ...(latest?.outputTokensPerSecond !== undefined ? {
      outputTokensPerSecond: latest.outputTokensPerSecond, outputRateSource: latest.outputRateSource,
    } : {}),
    ...(unknownCalls ? { unknownCalls } : {}),
    ...(unknownCalls || ledger.baseline?.incomplete || ledger.transient ? { incomplete: true } : {}),
    ...(ledger.epoch !== undefined ? { usageEpoch: ledger.epoch } : {}),
    ...(ledger.revision !== undefined ? { usageRevision: ledger.revision } : {}),
    scope: 'session', source: 'provider' };
}

function mergeUsage(previous: Record<string, unknown>, next: Record<string, unknown>) {
  const defined = Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined));
  const merged = { ...previous, ...defined };
  for (const key of ['input_token_details', 'output_token_details']) {
    if (record(defined[key])) merged[key] = { ...record(previous[key]), ...record(defined[key]) };
  }
  if (defined.total_tokens === undefined && (defined.input_tokens !== undefined || defined.output_tokens !== undefined)) {
    delete merged.total_tokens;
  }
  return merged;
}

function reportedReasoning(usage: Record<string, unknown> | null): number {
  const details = record(usage?.output_token_details) ?? record(usage?.completion_tokens_details);
  const count = details?.reasoning ?? details?.reasoning_tokens;
  return typeof count === 'number' && count > 0 ? count : 0;
}

function withoutRate(usage: TokenUsageSnapshot): TokenUsageSnapshot {
  const { outputTokensPerSecond: _rate, outputRateSource: _source, ...known } = usage;
  return known;
}

type StreamSample = { first: number; count: number; reasoning: boolean };

/** Observes every inherited model scope; each sample and rate belongs to one invocation. */
export function createSessionUsageTracker(options: {
  store: SessionUsageStore; threadId: string; baseline?: TokenUsageSnapshot;
  onUsage?: (usage: TokenUsageSnapshot) => void; now?: () => number;
}) {
  const { store, threadId } = options;
  const now = options.now ?? (() => performance.now());
  const streaming = new Map<string, StreamSample>();
  const runningUsage = new Map<string, Record<string, unknown>>();
  const publish = () => {
    const ledger = store.readSessionUsage(threadId);
    if (ledger) options.onUsage?.(summarizeSessionUsage(ledger));
  };
  const put = async (id: string, call: UsageCall) => {
    await store.putSessionUsageCall(threadId, id, call, options.baseline);
    publish();
  };
  const start = (id: string) => put(id, { pending: true });
  const noteOutput = (id: string, reasoning = false) => {
    const sample = streaming.get(id);
    streaming.set(id, sample ? { ...sample, count: sample.count + 1, reasoning: sample.reasoning || reasoning }
      : { first: now(), count: 1, reasoning });
  };
  const rate = (id: string, outputTokens: number | undefined, reasoningTokens: number) => {
    const sample = streaming.get(id);
    const elapsed = sample ? now() - sample.first : 0;
    return outputTokens !== undefined && sample && sample.count >= 2 && elapsed > 0 && (!reasoningTokens || sample.reasoning)
      ? outputTokens / (elapsed / 1000) : undefined;
  };
  const callbacks: Pick<BaseCallbackHandler,
    'handleLLMStart' | 'handleChatModelStart' | 'handleLLMNewToken' | 'handleLLMEnd' | 'handleLLMError' | 'handleChatModelStreamEvent'>
    & { name: string; raiseError: boolean; awaitHandlers: boolean } = {
    name: 'session-usage', raiseError: true, awaitHandlers: true,
    handleLLMStart: (_llm, _prompts, id) => start(id),
    handleChatModelStart: (_llm, _messages, id) => start(id),
    handleLLMNewToken: (token, _indices, id, _parent, _tags, fields) => {
      // Chunk counts establish streaming timing only; they never count tokens.
      if (token || fields?.chunk?.text) noteOutput(id);
    },
    handleChatModelStreamEvent: async (event, id) => {
      if (event.event === 'content-block-delta') {
        const delta = event.delta;
        if ((delta.type === 'text-delta' && delta.text)
          || (delta.type === 'reasoning-delta' && delta.reasoning)
          || (delta.type === 'data-delta' && delta.data)
          || (delta.type === 'block-delta' && typeof delta.fields.args === 'string' && delta.fields.args)) {
          noteOutput(id, delta.type === 'reasoning-delta');
        }
      }
      if ((event.event === 'usage' || event.event === 'message-start' || event.event === 'message-finish') && event.usage) {
        const snapshot = mergeUsage(runningUsage.get(id) ?? {}, event.usage);
        runningUsage.set(id, snapshot);
        const reported = readMessageTokenUsage({ usage_metadata: snapshot });
        if (!reported) return;
        const speed = rate(id, event.usage.output_tokens, reportedReasoning(snapshot));
        await put(id, { pending: true, usage: { ...reported,
          ...(speed !== undefined ? { outputTokensPerSecond: speed, outputRateSource: 'stream' } : {}) } });
      }
    },
    handleLLMEnd: async (result, id) => {
      // LangChain invokes the callback per prompt; alternatives share one
      // request's usage, so summing every choice double counts the same call.
      const message = result.generations[0]?.[0];
      const modelMessage = message && 'message' in message ? message.message : null;
      let reported = readMessageTokenUsage(modelMessage)
        ?? readMessageTokenUsage({ response_metadata: result.llmOutput });
      const metadata = record(record(modelMessage)?.usage_metadata);
      if (reported?.incomplete && metadata && runningUsage.has(id)) {
        reported = readMessageTokenUsage({ usage_metadata: mergeUsage(runningUsage.get(id)!, metadata) });
      }
      const responseUsage = record(record(modelMessage)?.response_metadata)?.usage;
      const outputUsage = result.llmOutput?.usage ?? result.llmOutput?.tokenUsage ?? result.llmOutput;
      const reasoning = Math.max(reportedReasoning(metadata), reportedReasoning(record(responseUsage)),
        reportedReasoning(runningUsage.get(id) ?? null), reportedReasoning(record(outputUsage)));
      const speed = rate(id, reported && !reported.incomplete ? reported.outputTokens : undefined, reasoning);
      streaming.delete(id);
      runningUsage.delete(id);
      const previous = store.readSessionUsage(threadId)?.calls[id]?.usage;
      await put(id, { state: 'completed', ...(reported ? { usage: { ...reported, scope: 'run', source: 'provider',
        ...(speed !== undefined ? { outputTokensPerSecond: speed, outputRateSource: 'final' } : {}) } }
        : previous ? { usage: { ...withoutRate(previous), incomplete: true } } : {}) });
    },
    handleLLMError: async (_error, id) => {
      streaming.delete(id);
      runningUsage.delete(id);
      const previous = store.readSessionUsage(threadId)?.calls[id]?.usage;
      await put(id, { state: 'failed', ...(previous ? { usage: { ...withoutRate(previous), incomplete: true } } : {}) });
    },
  };
  return { callbacks, publish };
}
