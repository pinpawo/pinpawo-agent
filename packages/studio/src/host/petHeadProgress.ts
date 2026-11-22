import { addAbortListener } from 'node:events';
import type { PetSessionPort } from 'pinpawo/host-runtime';

export type HeadRun = { invocationId: string; sessionId: string; requestId: string };
type RecordedPlan = NonNullable<Awaited<ReturnType<PetSessionPort['snapshot']>>['session']['currentPlan']>;
type SessionHistory = { latestDelivery?: string; recordedPlan?: RecordedPlan };
export type HeadSessionRunReader = (sessionId: string, signal: AbortSignal, isCurrent: () => boolean)
  => Promise<({ requestId: string } & SessionHistory) | undefined>;
export type HeadProgressEvidence = { status: 'unavailable' } | ({ status: 'running' } & SessionHistory);

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
    const { latestDelivery, recordedPlan } = sample;
    return { status: 'running', ...(latestDelivery ? { latestDelivery } : {}), ...(recordedPlan ? { recordedPlan } : {}) };
  } catch {
    return unavailable;
  } finally {
    listener?.[Symbol.dispose]();
  }
}
