import type { AgentSession } from '@pinpawo/agent-session';

export type TaskPauseMode = 'ordinary' | 'paused' | 'leaving';

/**
 * TUI-only choice for leaving an authoritative PauseTaskInterrupt. Whether a
 * task is paused always comes from Agent Session; this state only remembers
 * that Esc selected "start a new task" for the next composer submission.
 */
export function syncTaskPauseMode(
  current: TaskPauseMode,
  session: AgentSession,
): TaskPauseMode {
  if (session.pendingInterrupt?.payload.kind !== 'pause_task') {
    return 'ordinary';
  }
  return current === 'leaving' ? 'leaving' : 'paused';
}

export function leaveTaskPauseMode(
  current: TaskPauseMode,
): TaskPauseMode {
  return current === 'paused' ? 'leaving' : current;
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
