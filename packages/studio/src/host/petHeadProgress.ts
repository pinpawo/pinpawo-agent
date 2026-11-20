import { addAbortListener } from 'node:events';

export type HeadRun = { invocationId: string; sessionId: string; requestId: string };
export type HeadSessionRunReader = (sessionId: string, signal: AbortSignal, isCurrent: () => boolean) => Promise<string | undefined>;
export type HeadProgressEvidence = { status: 'unavailable' | 'running' };

/** Bound one status sample to its deadline, the caller's signal and the exact run. */
export async function readHeadProgress(input: {
  run: HeadRun; signal: AbortSignal; isCurrent: () => boolean; readSessionRunId: HeadSessionRunReader;
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
    const requestId = await Promise.race([input.readSessionRunId(run.sessionId, signal, isCurrent), cancelled]);
    return !signal.aborted && isCurrent() && requestId === run.requestId ? { status: 'running' } : unavailable;
  } catch {
    return unavailable;
  } finally {
    listener?.[Symbol.dispose]();
  }
}
