import type { OrchestratorStateType } from '../../state';

export function afterPrepare(state: OrchestratorStateType) {
  return state.runTerminalOutcome?.kind === 'checkpoint_incompatible'
    ? 'finalizeRun'
    : 'compactContext';
}
