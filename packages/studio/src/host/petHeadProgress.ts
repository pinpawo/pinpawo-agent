import { addAbortListener } from 'node:events';
import type { PetSessionRunProgress } from 'pinpawo/host-runtime';

export type HeadRun = { invocationId: string; sessionId: string; requestId: string };
export type HeadSessionRunReader = (sessionId: string, signal: AbortSignal, isCurrent: () => boolean, includeRunProgress?: true)
  => Promise<{ requestId: string; runProgress?: PetSessionRunProgress } | undefined>;
export type HeadProgressEvidence = { status: 'unavailable' } | ({ status: 'running' } & PetSessionRunProgress);

/** Bound one status sample to its deadline, the caller's signal and the exact run. */
export async function readHeadProgress(input: {
  run: HeadRun; signal: AbortSignal; isCurrent: () => boolean; readSessionRun: HeadSessionRunReader; includeRunProgress?: true;
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
    const sample = await Promise.race([input.readSessionRun(run.sessionId, signal, isCurrent, input.includeRunProgress), cancelled]);
    if (signal.aborted || !isCurrent() || sample?.requestId !== run.requestId) return unavailable;
    const progress = input.includeRunProgress ? sample.runProgress : undefined;
    return { status: 'running', ...(progress?.latestDelivery ? { latestDelivery: progress.latestDelivery } : {}),
      ...(progress?.pendingObjectives?.length ? { pendingObjectives: progress.pendingObjectives } : {}) };
  } catch {
    return unavailable;
  } finally {
    listener?.[Symbol.dispose]();
  }
}
