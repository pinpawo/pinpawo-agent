import type { OrchestratorStatePatch } from '../../controlPrimitives';

export function finalizeRun(): OrchestratorStatePatch {
  return {
    runPendingFinalReply: null,
  };
}
