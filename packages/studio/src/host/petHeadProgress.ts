import { addAbortListener } from 'node:events';
import type { PetSessionProgress } from 'pinpawo/host-runtime';

export type HeadRun = { invocationId: string; sessionId: string; requestId: string };
export type HeadSessionRunReader = (sessionId: string, signal: AbortSignal, isCurrent: () => boolean, includeSessionProgress?: true)
  => Promise<{ requestId: string; sessionProgress?: PetSessionProgress } | undefined>;
export type HeadProgressEvidence = { status: 'unavailable' } | { status: 'running'; sessionProgress?: PetSessionProgress };

/** Bound one status sample to its deadline, the caller's signal and the exact run. */
export async function readHeadProgress(input: {
  run: HeadRun; signal: AbortSignal; isCurrent: () => boolean; readSessionRun: HeadSessionRunReader; includeSessionProgress?: true;
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
    const sample = await Promise.race([input.readSessionRun(run.sessionId, signal, isCurrent, input.includeSessionProgress), cancelled]);
    if (signal.aborted || !isCurrent() || sample?.requestId !== run.requestId) return unavailable;
    const progress = input.includeSessionProgress ? sample.sessionProgress : undefined;
    return { status: 'running', ...(progress ? { sessionProgress: progress } : {}) };
  } catch {
    return unavailable;
  } finally {
    listener?.[Symbol.dispose]();
  }
}
