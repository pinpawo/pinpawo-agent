import { addAbortListener } from 'node:events';
import type { Studio, StudioPetSessions } from '../studioContract';
import type { HeadContext, HeadSchedulingSnapshot } from './petHead';

type Active = NonNullable<HeadSchedulingSnapshot['active']>;
type Run = { invocationId: string; sessionId: string; requestId: string; publishedIds: readonly string[] };
export type HeadRunReader = (active: Active) => Run | undefined;
type Snapshot = Awaited<ReturnType<StudioPetSessions['snapshot']>>;
export type HeadProgressSnapshotReader = (sessionId: string, signal: AbortSignal, isCurrent: () => boolean) => Promise<Snapshot | undefined>;
export type HeadProgressEvidence = { status: 'unavailable' } | {
  status: 'running';
  publishedUpdates?: Array<{ messageId: string; text: string }>;
};

/** Only correlate the live run on this Pet's own topic. Never publish from an event. */
export function observeHeadRun(subscribe: Studio['subscribe'], petId: string, channelId: string, signal: AbortSignal) {
  let current: Run | undefined;
  const unsubscribe = subscribe(event => {
    if (signal.aborted || event.source !== 'resident-pet' || event.topic !== petId) return;
    const payload = event.payload as Partial<{
      petId: string; invocationId: string; sessionId: string; requestId: string;
      scope: { namespace: string; id: string }; message: { type: string; messageId: string };
    }> | undefined;
    if (!payload || payload.petId !== petId || payload.scope?.namespace !== 'channel' || payload.scope.id !== channelId ||
      typeof payload.invocationId !== 'string' || !payload.invocationId || typeof payload.sessionId !== 'string' || !payload.sessionId ||
      typeof payload.requestId !== 'string' || !payload.requestId) return;
    const { invocationId, sessionId, requestId } = payload;
    const matches = current && current.invocationId === invocationId && current.sessionId === sessionId && current.requestId === requestId;
    if (event.type === 'dispatch.running') {
      if (!matches) current = { invocationId, sessionId, requestId, publishedIds: [] };
    } else if (matches && current) {
      if (event.type === 'dispatch.waiting' || event.type === 'dispatch.completed' || event.type === 'dispatch.failed' || event.type === 'dispatch.interrupted') {
        current = undefined;
      } else if (event.type === 'dispatch.message' && payload.message?.type === 'message.completed') {
        const id = payload.message.messageId;
        if (typeof id === 'string' && id && !current.publishedIds.includes(id)) {
          current = { ...current, publishedIds: [...current.publishedIds.slice(-4), id] };
        }
      }
    }
  }, { source: 'resident-pet', topic: petId });
  return {
    close: () => { current = undefined; unsubscribe(); },
    read: (active: Active) => !signal.aborted && current?.invocationId === active.dispatchId && current.sessionId === active.sessionId
      ? current : undefined,
  };
}

export async function readHeadProgress(input: {
  active: Active; run: Run; context: HeadContext; signal: AbortSignal; petId: string; channelId: string;
  isCurrent: () => boolean;
  snapshot: HeadProgressSnapshotReader;
}): Promise<HeadProgressEvidence> {
  const { active, run, context, isCurrent } = input;
  const unavailable = { status: 'unavailable' } as const;
  if (input.signal.aborted || !isCurrent()) return unavailable;
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(2500)]);
  let listener: Disposable | undefined;
  try {
    const cancelled = new Promise<undefined>(resolve => {
      listener = addAbortListener(signal, () => resolve(undefined));
    });
    const snapshot = await Promise.race([input.snapshot(active.sessionId, signal, isCurrent), cancelled]);
    if (!snapshot || signal.aborted || !isCurrent() || snapshot.session.sessionId !== active.sessionId ||
      snapshot.session.activeRun?.state !== 'running' || snapshot.session.activeRun.requestId !== run.requestId) return unavailable;
    // No raw Session entry, plan, tool, or TUI text is exposed. Only a
    // completed assistant entry also observed on this run AND already
    // committed to this Channel can contribute its public Channel text.
    const verifiedIds = new Set(snapshot.session.timeline.flatMap(entry =>
      entry.type === 'message' && entry.role === 'assistant' && entry.status === 'completed' &&
      run.publishedIds.includes(entry.id) ? [entry.id] : []));
    const seen = new Set<string>();
    const publishedUpdates = context.messages.slice().reverse().flatMap(message => {
      if (!message.externalRef || !verifiedIds.has(message.externalRef) || seen.has(message.externalRef) ||
        message.channelId !== input.channelId || message.author.kind !== 'pet' || message.author.id !== input.petId) return [];
      seen.add(message.externalRef);
      return [{ messageId: message.messageId, text: message.body.slice(0, 500) }];
    }).slice(0, 3).reverse();
    return { status: 'running', ...(publishedUpdates.length ? { publishedUpdates } : {}) };
  } catch {
    return unavailable;
  } finally {
    listener?.[Symbol.dispose]();
  }
}
