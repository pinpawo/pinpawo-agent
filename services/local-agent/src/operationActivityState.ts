import type {
  AgentOperationEvent,
  AgentOperationPhase,
} from '@pinpawo/agent-session';

type ActiveOperationState = {
  kind: string;
  title?: string;
  target?: string;
  summary?: string;
  phase: AgentOperationPhase;
  updatedAt: number;
  eventId: number;
  expiresAt?: number;
};

type AgentRunPhase =
  | 'thinking'
  | 'using_tool'
  | 'streaming'
  | 'waiting_human'
  | 'interrupted'
  | 'error';

type AgentRunState = {
  phase: AgentRunPhase;
  requestId?: string;
  updatedAt: number;
  expiresAt?: number;
};

let activeOperationState: ActiveOperationState | null = null;
let agentRunState: AgentRunState | null = null;
let nextOperationEventId = 1;

function setActiveOperation(event: AgentOperationEvent, visibleForMs?: number) {
  const now = Date.now();
  activeOperationState = {
    kind: event.operation.kind,
    phase: event.phase,
    updatedAt: now,
    eventId: nextOperationEventId++,
    ...(event.operation.title !== undefined ? { title: event.operation.title } : {}),
    ...(event.operation.target !== undefined ? { target: event.operation.target } : {}),
    ...(event.operation.summary !== undefined ? { summary: event.operation.summary } : {}),
    ...(visibleForMs ? { expiresAt: now + visibleForMs } : {}),
  };
}

export function recordAgentRunActivity(phase: AgentRunPhase, requestId?: string, visibleForMs?: number) {
  const now = Date.now();
  agentRunState = {
    phase,
    updatedAt: now,
    ...(requestId !== undefined ? { requestId } : {}),
    ...(visibleForMs ? { expiresAt: now + visibleForMs } : {}),
  };
}

export function clearAgentRunActivity(requestId?: string) {
  if (requestId && agentRunState?.requestId && agentRunState.requestId !== requestId) return;
  agentRunState = null;
  activeOperationState = null;
}

export function recordOperationActivity(event: AgentOperationEvent) {
  if (!event.operation.kind) return;

  if (event.phase === 'started' || event.phase === 'updated') {
    setActiveOperation(event);
    recordAgentRunActivity('using_tool', event.requestId);
    return;
  }

  if (event.phase === 'interrupted') {
    setActiveOperation(event, 10_000);
    recordAgentRunActivity('waiting_human', event.requestId);
    return;
  }

  if (event.phase === 'failed') {
    setActiveOperation(event, 5_000);
    recordAgentRunActivity('error', event.requestId, 5_000);
    return;
  }

  setActiveOperation(event, 2_500);
}

function readAgentRunHealthFields(now: number) {
  if (!agentRunState) return {};
  if (agentRunState.expiresAt && now > agentRunState.expiresAt) {
    agentRunState = null;
    return {};
  }
  // Do not time out an active turn here. The chat/runtime paths call
  // clearAgentRunActivity() when the turn actually ends; clearing by age makes
  // long-running model/tool work look idle in the macOS pet UI.
  return {
    agent_run_phase: agentRunState.phase,
    agent_run_request_id: agentRunState.requestId,
    agent_run_updated_at: new Date(agentRunState.updatedAt).toISOString(),
  };
}

function readActiveOperationFields(now: number) {
  if (!activeOperationState) return {};
  if (activeOperationState.expiresAt && now > activeOperationState.expiresAt) {
    activeOperationState = null;
    return {};
  }
  // Non-expiring operation activity means the operation is still in progress.
  // It is cleared with the turn, or converted to a short hold when it ends.
  return {
    active_operation_kind: activeOperationState.kind,
    active_operation_title: activeOperationState.title,
    active_operation_target: activeOperationState.target,
    active_operation_summary: activeOperationState.summary,
    active_operation_phase: activeOperationState.phase,
    active_operation_event_id: activeOperationState.eventId,
    active_operation_updated_at: new Date(activeOperationState.updatedAt).toISOString(),
  };
}

export function readAgentActivityHealthFields() {
  const now = Date.now();
  return {
    ...readAgentRunHealthFields(now),
    ...readActiveOperationFields(now),
  };
}
