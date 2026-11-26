import { addAbortListener } from 'node:events';
import type { PetSessionPort } from 'pinpawo/host-runtime';

export type HeadRun = { invocationId: string; sessionId: string; requestId: string };
type RecordedPlan = NonNullable<Awaited<ReturnType<PetSessionPort['snapshot']>>['session']['currentPlan']>;
export type HeadResultMessage = { messageId: string; requestId: string };
type PublicResult = { body: string };
type SessionSample = {
  status: 'ready' | 'running' | 'waiting' | 'unavailable';
  sessionId?: string;
  requestId?: string;
  recordedPlan?: RecordedPlan;
  result?: PublicResult;
};
type ReadOptions = [signal: AbortSignal, isCurrent: () => boolean, result?: HeadResultMessage];
export type HeadSessionReader = (sessionId: string | undefined, ...options: ReadOptions) => Promise<SessionSample | undefined>;
export type HeadProgressEvidence = { status: 'unavailable' | 'waiting' }
  | { status: 'running'; recordedPlan?: RecordedPlan; result?: PublicResult };

/** Bound a Session port read to the turn's lifetime. Missing evidence is not readiness. */
export async function readHeadSession(
  input: { signal: AbortSignal; isCurrent: () => boolean; read: (signal: AbortSignal) => ReturnType<HeadSessionReader> },
): ReturnType<HeadSessionReader> {
  if (input.signal.aborted || !input.isCurrent()) return;
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(2500)]);
  let listener: Disposable | undefined;
  try {
    const cancelled = new Promise<undefined>(resolve => { listener = addAbortListener(signal, () => resolve(undefined)); });
    const sample = await Promise.race([input.read(signal), cancelled]);
    return !signal.aborted && input.isCurrent() ? sample : undefined;
  } catch {
    return;
  } finally { listener?.[Symbol.dispose](); }
}

/** Interpret a Session sample as evidence for one observed request, never as queue authority. */
export function headProgress(sample: SessionSample | undefined, requestId: string): HeadProgressEvidence {
  if (sample?.status === 'waiting') return { status: 'waiting' };
  if (sample?.status !== 'running' || sample.requestId !== requestId) return { status: 'unavailable' };
  return { status: 'running', ...(sample.recordedPlan ? { recordedPlan: sample.recordedPlan } : {}),
    ...(sample.result ? { result: sample.result } : {}) };
}
