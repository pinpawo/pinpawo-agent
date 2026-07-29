import type { AgentRunView } from '@pinpawo/agent-session';
import type { ApprovalState } from '../overlays/approvalModel';

export type GlobalInterruptAction =
  | 'cancel-review'
  | 'interrupt-run'
  | 'exit';

export function resolveGlobalInterruptAction(input: {
  approvalPhase: ApprovalState['phase'];
  activeRun: AgentRunView | null;
}): GlobalInterruptAction {
  if (input.approvalPhase === 'submitting') return 'exit';
  if (input.approvalPhase !== 'closed') return 'cancel-review';
  if (input.activeRun?.state === 'interrupting') return 'exit';
  return input.activeRun ? 'interrupt-run' : 'exit';
}
