import { message, type PresentationMessage } from './types';

export function presentStudioTurnEvent(event: Record<string, unknown>): PresentationMessage | null {
  const type = typeof event.type === 'string' ? event.type : null;
  if (!type) return null;

  switch (type) {
    case 'turn_started':
    case 'turn_finished':
      return null;
    case 'plan_set': {
      const plan = event.plan && typeof event.plan === 'object'
        ? event.plan as Record<string, unknown>
        : null;
      const tasks = plan && Array.isArray(plan.tasks) ? plan.tasks : [];
      return message('studio.plan_set', { count: tasks.length });
    }
    case 'dispatch_started':
      return message('studio.dispatch_started', {
        petId: typeof event.petId === 'string' ? event.petId : '?',
        taskIndex: typeof event.taskIndex === 'number' ? event.taskIndex : '?',
      });
    case 'task_status_changed':
      return message('studio.task_status_changed', {
        taskIndex: typeof event.taskIndex === 'number' ? event.taskIndex : '?',
        status: typeof event.status === 'string' ? event.status : '?',
      });
    case 'wiki_updated':
      return message('studio.wiki_updated', {
        count: Array.isArray(event.changedPaths) ? event.changedPaths.length : 0,
      });
    case 'dispatch_finished':
      return message('studio.dispatch_finished', {
        dispatchId: typeof event.dispatchId === 'string' ? event.dispatchId : '?',
        status: typeof event.status === 'string' ? event.status : '?',
      });
    default:
      return message('studio.event', { type });
  }
}
