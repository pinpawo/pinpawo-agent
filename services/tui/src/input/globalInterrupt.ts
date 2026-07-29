import type { AgentRunView } from '@pinpawo/agent-session';
import type { ApprovalState } from '../overlays/approvalModel';

export type GlobalInterruptAction =
  | 'cancel-review'
  | 'interrupt-run'
  | 'exit';

export function resolveGlobalInterruptAction(input: {
  approval: ApprovalState;
  activeRun: AgentRunView | null;
}): GlobalInterruptAction {
  if (input.approval.phase === 'resolution-sent') {
    return input.approval.interruptSent ? 'exit' : 'interrupt-run';
  }
  if (input.approval.phase !== 'closed') return 'cancel-review';
  if (input.activeRun?.state === 'interrupting') return 'exit';
  return input.activeRun ? 'interrupt-run' : 'exit';
}
