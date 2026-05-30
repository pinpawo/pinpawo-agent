import type {
  LocalAgentOperationEvent,
  LocalAgentStudioProgressEvent,
} from '../../events/localAgentEvent';

export function shorten(value: string, max = 60) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

export function getOperationKey(event: LocalAgentOperationEvent) {
  return event.operation.id
    ?? event.operation.source?.callId
    ?? event.operation.source?.name
    ?? event.operation.kind;
}

export function formatOperationStart(event: LocalAgentOperationEvent) {
  return {
    label: event.operation.title ?? event.operation.kind,
    detail: formatOperationDetail(event) || event.operation.kind,
  };
}

export function formatOperationProgress(event: LocalAgentOperationEvent) {
  return formatOperationDetail(event);
}

export function formatOperationResult(event: LocalAgentOperationEvent) {
  const label = event.operation.title ?? event.operation.kind;
  if (event.phase === 'failed') {
    return `${label}：失败${event.operation.summary ? ` · ${shorten(event.operation.summary, 80)}` : ''}`;
  }
  if (event.phase === 'interrupted') {
    return `${label}：已中断`;
  }
  const detail = formatOperationDetail(event, 80);
  return `${label}：${detail || '已完成'}`;
}

export function formatStudioProgressEvent(event: LocalAgentStudioProgressEvent): string | null {
  const payload = event.event;
  const type = typeof payload.type === 'string' ? payload.type : null;
  if (!type) return null;
  switch (type) {
    case 'turn_started':
    case 'turn_finished':
      return null;
    case 'plan_set': {
      const plan = payload.plan && typeof payload.plan === 'object'
        ? payload.plan as Record<string, unknown>
        : null;
      const tasks = plan && Array.isArray(plan.tasks) ? plan.tasks : [];
      return `[studio] plan 设定:${tasks.length} 棒`;
    }
    case 'dispatch_started': {
      const petId = typeof payload.petId === 'string' ? payload.petId : '?';
      const taskIndex = typeof payload.taskIndex === 'number' ? payload.taskIndex : '?';
      return `[studio] dispatch[#${taskIndex}] → pet:${petId}`;
    }
    case 'task_status_changed': {
      const taskIndex = typeof payload.taskIndex === 'number' ? payload.taskIndex : '?';
      const status = typeof payload.status === 'string' ? payload.status : '?';
      return `[studio] task[#${taskIndex}] → ${status}`;
    }
    case 'wiki_updated': {
      const changed = Array.isArray(payload.changedPaths) ? payload.changedPaths : [];
      return `[studio] wiki 更新 ${changed.length} 项`;
    }
    case 'dispatch_finished': {
      const dispatchId = typeof payload.dispatchId === 'string' ? payload.dispatchId : '?';
      const status = typeof payload.status === 'string' ? payload.status : '?';
      return `[studio] dispatch ${dispatchId} → ${status}`;
    }
    default:
      return `[studio] event: ${type}`;
  }
}

function formatOperationDetail(event: LocalAgentOperationEvent, max = 60) {
  const pieces = [
    event.operation.target,
    event.operation.summary,
    formatDetails(event.operation.details),
  ].filter((item): item is string => Boolean(item));
  return pieces.length > 0 ? shorten(pieces.join(' · '), max) : '';
}

function formatDetails(details: Record<string, unknown> | undefined) {
  if (!details) return '';
  return Object.entries(details)
    .flatMap(([key, value]) => {
      if (value === undefined || value === null || value === '') return [];
      return [`${key}=${String(value)}`];
    })
    .join(' · ');
}
