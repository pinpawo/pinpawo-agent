import type {
  AgentSessionMessageInput,
  AgentStudioProgressEvent,
} from '@pinpawo/agent-session';

export function studioUserMessage(userRequest: string) {
  return `[studio] ${userRequest}`;
}

export function studioProgressMessage(
  event: AgentStudioProgressEvent,
): AgentSessionMessageInput | null {
  const text = formatStudioProgress(event.event);
  return text
    ? {
        role: 'system',
        requestId: event.requestId,
        text,
      }
    : null;
}

export function studioCompletionMessages(input: {
  requestId: string;
  outcome: 'done' | 'stopped';
  reply: string;
  reason?: string;
}): AgentSessionMessageInput[] {
  const reply = input.reply.trim();
  const messages: AgentSessionMessageInput[] = [{
    role: reply ? 'assistant' : 'system',
    requestId: input.requestId,
    text: reply || `[studio] turn ${input.outcome} without final output`,
  }];
  const reason = input.reason?.trim();
  if (input.outcome === 'stopped' && reason) {
    messages.push({
      role: 'system',
      requestId: input.requestId,
      text: `[studio] stopped: ${reason}`,
    });
  }
  return messages;
}

export function studioErrorMessage(
  requestId: string,
  message: string,
): AgentSessionMessageInput {
  return {
    role: 'system',
    requestId,
    text: `[studio error] ${message.trim() || 'unknown Studio error'}`,
  };
}

function formatStudioProgress(payload: Record<string, unknown>) {
  const type = typeof payload.type === 'string' ? payload.type : null;
  if (!type) return null;
  switch (type) {
    case 'turn_started':
    case 'turn_finished':
      return null;
    case 'tasks_queued':
      return `[studio] queued ${numberOr(payload.taskCount, 0)} tasks`;
    case 'task_started':
      return [
        `[studio] task ${numberOr(payload.taskIndex, '?')} started`,
        stringOr(payload.petId, '?'),
      ].join(' · ');
    case 'task_status_changed':
      return [
        `[studio] task ${numberOr(payload.taskIndex, '?')}`,
        stringOr(payload.status, '?'),
      ].join(' · ');
    case 'wiki_updated': {
      const changedPaths = Array.isArray(payload.changedPaths)
        ? payload.changedPaths
        : [];
      return `[studio] wiki updated · ${changedPaths.length} paths`;
    }
    case 'task_finished':
      return [
        `[studio] run ${stringOr(payload.petRunId, '?')}`,
        stringOr(payload.status, '?'),
      ].join(' · ');
    default:
      return `[studio] ${type}`;
  }
}

function stringOr(value: unknown, fallback: string) {
  return typeof value === 'string' ? value : fallback;
}

function numberOr(value: unknown, fallback: number | string) {
  return typeof value === 'number' ? value : fallback;
}
