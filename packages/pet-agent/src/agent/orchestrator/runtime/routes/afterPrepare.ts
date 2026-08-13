import type { OrchestratorStateType } from '../../state';

export function afterPrepare(state: OrchestratorStateType) {
  return state.runRuntimeFailure === 'checkpoint_incompatible'
    ? 'answer'
    : 'compactContext';
}
