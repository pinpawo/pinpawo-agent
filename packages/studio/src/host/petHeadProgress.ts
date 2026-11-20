import { addAbortListener } from 'node:events';
import type { StudioPetSessions } from '../studioContract';
import type { HeadContext, HeadSchedulingSnapshot } from './petHead';

type Active = NonNullable<HeadSchedulingSnapshot['active']>;
export type HeadRun = { invocationId: string; sessionId: string; requestId: string; publishedIds: readonly string[] };
export type HeadRunReader = (active: Active) => HeadRun | undefined;
type Snapshot = Awaited<ReturnType<StudioPetSessions['snapshot']>>;
export type HeadProgressSnapshotReader = (sessionId: string, signal: AbortSignal, isCurrent: () => boolean) => Promise<Snapshot | undefined>;
export type HeadProgressEvidence = { status: 'unavailable' } | {
  status: 'running';
  publishedUpdates?: Array<{ messageId: string; text: string }>;
};

/** Bound one progress read to its own deadline, the caller's signal and the same active run. */
export async function readHeadProgress(input: {
  active: Active; run: HeadRun; context: HeadContext; signal: AbortSignal; petId: string; channelId: string;
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
