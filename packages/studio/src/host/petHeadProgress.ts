import { addAbortListener } from 'node:events';
import type { PetDispatchLifecycleState, PetDispatchQueueEntry, PetDispatchQueueSnapshot, PetSessionPort } from 'pinpawo/host-runtime';
import type { Studio } from '../studioContract';

export type HeadRun = { invocationId: string; sessionId: string; requestId: string };
type RecordedPlan = NonNullable<Awaited<ReturnType<PetSessionPort['snapshot']>>['session']['currentPlan']>;
export type HeadSessionRunReader = (sessionId: string, signal: AbortSignal, isCurrent: () => boolean)
  => Promise<{ requestId: string; recordedPlan?: RecordedPlan } | undefined>;
export type HeadProgressEvidence = { status: 'unavailable' } | { status: 'running'; recordedPlan?: RecordedPlan };

/** Bound one status sample to its deadline, the caller's signal and the exact run. */
export async function readHeadProgress(input: {
  run: HeadRun; signal: AbortSignal; isCurrent: () => boolean; readSessionRun: HeadSessionRunReader;
}): Promise<HeadProgressEvidence> {
  const { run, isCurrent } = input;
  const unavailable = { status: 'unavailable' } as const;
  if (input.signal.aborted || !isCurrent()) return unavailable;
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(2500)]);
  let listener: Disposable | undefined;
  try {
    const cancelled = new Promise<undefined>(resolve => {
      listener = addAbortListener(signal, () => resolve(undefined));
    });
    const sample = await Promise.race([input.readSessionRun(run.sessionId, signal, isCurrent), cancelled]);
    if (signal.aborted || !isCurrent() || sample?.requestId !== run.requestId) return unavailable;
    return { status: 'running', ...(sample.recordedPlan ? { recordedPlan: sample.recordedPlan } : {}) };
  } catch {
    return unavailable;
  } finally {
    listener?.[Symbol.dispose]();
  }
}

/** Read-only facts for this Channel's bound Session, not admission decisions. */
export type HeadTaskFact = {
  messageId: string;
  status: Exclude<PetDispatchLifecycleState, 'message'>;
  plan?: Array<{ status: string; description: string }>;
};

type TaskOutcome = Pick<HeadTaskFact, 'status'> & { sessionId: string; messageId: string };

export function observeHeadDispatch(input: {
  petId: string;
  channelId: string;
  subscribe: Studio['subscribe'];
  snapshot: () => PetDispatchQueueSnapshot;
}, signal: AbortSignal) {
  const { petId, channelId, snapshot } = input;
  let run: HeadRun | undefined;
  // An event is evidence, not history storage. Keep only recent outcomes seen
  // by this live instance, and never infer completion from queue absence.
  const outcomes = new Map<string, TaskOutcome>();
  const unsubscribe = input.subscribe(event => {
    if (signal.aborted || event.source !== 'resident-pet' || event.topic !== petId) return;
    const data = event.payload as Partial<{
      petId: string; invocationId: string; sessionId: string; requestId: string;
      scope: { namespace: string; id: string }; origin: { namespace: string; id: string };
    }> | undefined;
    if (data?.petId !== petId || data.scope?.namespace !== 'channel' || data.scope.id !== channelId ||
      !data.invocationId || !data.sessionId) return;
    const { invocationId, sessionId, requestId } = data;
    if (!event.type.startsWith('dispatch.')) return;
    const status = event.type.slice('dispatch.'.length);
    if (status === 'running' && requestId) {
      run = { invocationId, sessionId, requestId };
    } else if (status !== 'waiting' && status !== 'completed' && status !== 'failed' &&
      status !== 'interrupted' && status !== 'superseded') return;
    else if (run?.invocationId === invocationId && run.sessionId === sessionId) {
      if (requestId && run.requestId !== requestId) return;
      run = undefined;
    }
    const messageId = data.origin?.namespace === 'channel' ? data.origin.id : outcomes.get(invocationId)?.messageId;
    if (!messageId) return;
    outcomes.delete(invocationId);
    outcomes.set(invocationId, { sessionId, messageId, status });
    if (outcomes.size > 10) outcomes.delete(outcomes.keys().next().value!);
  }, { source: 'resident-pet', topic: petId });

  async function readSession(sessionId: string, sourceIds: ReadonlySet<string>, readPlan?: HeadSessionRunReader): Promise<HeadTaskFact[]> {
    if (signal.aborted || !sourceIds.size) return [];
    const belongs = (entry: PetDispatchQueueEntry) =>
      entry.sessionId === sessionId && entry.scope?.namespace === 'channel' && entry.scope.id === channelId &&
      entry.origin?.namespace === 'channel' && sourceIds.has(entry.origin.id);
    const read = () => {
      const queue = snapshot();
      const facts = new Map<string, HeadTaskFact>();
      for (const [id, item] of outcomes) {
        if (item.sessionId === sessionId && sourceIds.has(item.messageId) && item.status !== 'running') {
          facts.set(id, { messageId: item.messageId, status: item.status });
        }
      }
      const active = queue.activeOperation === 'dispatch' && queue.activeDispatch && belongs(queue.activeDispatch) &&
        !facts.has(queue.activeDispatch.dispatchId) ? queue.activeDispatch : undefined;
      for (const item of queue.entries ?? []) {
        if (belongs(item) && !facts.has(item.dispatchId)) facts.set(item.dispatchId, { messageId: item.origin!.id, status: 'queued' });
      }
      if (active) facts.set(active.dispatchId, { messageId: active.origin!.id, status: 'running' });
      return { active, facts };
    };
    let { active, facts } = read();
    const observed = run;
    if (active && observed?.invocationId === active.dispatchId && observed.sessionId === sessionId && readPlan) {
      const isCurrent = () => run === observed && snapshot().activeDispatch?.dispatchId === observed.invocationId;
      const evidence = await readHeadProgress({ run: observed, signal, isCurrent, readSessionRun: readPlan });
      ({ active, facts } = read());
      const fact = active?.dispatchId === observed.invocationId ? facts.get(active.dispatchId) : undefined;
      if (evidence.status === 'running' && evidence.recordedPlan && fact && isCurrent()) {
        fact.plan = evidence.recordedPlan.items.map(({ task, status }) => ({ status, description: task }));
      }
    }
    return signal.aborted ? [] : [...facts.values()];
  }
  return { readSession, close: () => { unsubscribe(); outcomes.clear(); run = undefined; } };
}
