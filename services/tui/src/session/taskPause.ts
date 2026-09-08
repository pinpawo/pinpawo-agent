import type { AgentSession } from '@pinpawo/agent-session';

export function hasUnfinishedTask(session: AgentSession): boolean {
  return Boolean(session.currentPlan?.items.some((item) => item.status !== 'completed'));
}

export type TaskPauseMode = 'ordinary' | 'paused' | 'leaving';

/**
 * TUI-only choice for leaving a paused task or ordinary unfinished work. Whether a
 * task is paused always comes from Agent Session; this state only remembers
 * that Esc selected "start a new task" for the next composer submission.
 */
export function syncTaskPauseMode(
  current: TaskPauseMode,
  session: AgentSession,
): TaskPauseMode {
  if (session.pendingInterrupt?.payload.kind !== 'pause_task') {
    return current === 'leaving' && !session.activeRun && !session.pendingInterrupt
      && hasUnfinishedTask(session) ? 'leaving' : 'ordinary';
  }
  return current === 'leaving' ? 'leaving' : 'paused';
}

export function leaveTaskPauseMode(
  _current: TaskPauseMode,
): TaskPauseMode {
  return 'leaving';
}

export function isTaskPaused(mode: TaskPauseMode) {
  return mode === 'paused';
}

export function resumesPausedTaskOnEmptySubmit(
  mode: TaskPauseMode,
  text: string,
  _attachmentCount: number,
) {
  return mode === 'paused' && !text.trim();
}
