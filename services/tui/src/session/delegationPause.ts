import type { AgentSession } from '@pinpawo/agent-session';

export type DelegationPauseMode = 'ordinary' | 'paused' | 'leaving';

/**
 * TUI composer continuation after an interrupted event or a reply with unfinished work. The
 * server remains authoritative: this state selects the transition carried by
 * the next chat request but never creates or clears a delegation itself.
 */
export function syncDelegationPauseMode(
  current: DelegationPauseMode,
  session: AgentSession,
): DelegationPauseMode {
  if (session.activeRun || session.pendingInterrupt) {
    return 'ordinary';
  }
  if (current !== 'leaving' && session.currentPlan?.items.some((item) => item.status !== 'completed')) {
    return 'paused';
  }
  return current;
}

export function leaveDelegationPauseMode(
  current: DelegationPauseMode,
): DelegationPauseMode {
  return current === 'paused' ? 'leaving' : current;
}

export function isDelegationPaused(mode: DelegationPauseMode) {
  return mode === 'paused';
}

export function resumesPausedDelegationOnEmptySubmit(
  mode: DelegationPauseMode,
  text: string,
  _attachmentCount: number,
) {
  return mode === 'paused' && !text.trim();
}
