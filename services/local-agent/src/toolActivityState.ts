export type ToolActivityPhase = 'start' | 'end' | 'complete' | 'error' | 'event' | 'interrupt';

type ActiveToolState = {
  name: string;
  phase: ToolActivityPhase;
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

let activeToolState: ActiveToolState | null = null;
let agentRunState: AgentRunState | null = null;
let nextToolEventId = 1;

function setActiveTool(name: string, phase: ToolActivityPhase, visibleForMs?: number) {
  const now = Date.now();
  activeToolState = {
    name,
    phase,
    updatedAt: now,
    eventId: nextToolEventId++,
    expiresAt: visibleForMs ? now + visibleForMs : undefined,
  };
}

function holdCurrentTool(name?: string, visibleForMs = 2_500) {
  if (!activeToolState) return;
  if (name && activeToolState.name !== name) return;
  setActiveTool(activeToolState.name, activeToolState.phase, visibleForMs);
}

export function recordAgentRunActivity(phase: AgentRunPhase, requestId?: string, visibleForMs?: number) {
  const now = Date.now();
  agentRunState = {
    phase,
    requestId,
    updatedAt: now,
    expiresAt: visibleForMs ? now + visibleForMs : undefined,
  };
}

export function clearAgentRunActivity(requestId?: string) {
  if (requestId && agentRunState?.requestId && agentRunState.requestId !== requestId) return;
  agentRunState = null;
  activeToolState = null;
}

export function recordToolActivity(name: string, phase: ToolActivityPhase, requestId?: string) {
  if (!name) return;

  if (phase === 'start' || phase === 'event') {
    setActiveTool(name, phase);
    recordAgentRunActivity('using_tool', requestId);
    return;
  }

  if (phase === 'interrupt') {
    setActiveTool(name, phase, 10_000);
    recordAgentRunActivity('waiting_human', requestId);
    return;
  }

  if (phase === 'error') {
    setActiveTool(name, phase, 5_000);
    recordAgentRunActivity('error', requestId, 5_000);
    return;
  }

  holdCurrentTool(name);
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

function readActiveToolFields(now: number) {
  if (!activeToolState) return {};
  if (activeToolState.expiresAt && now > activeToolState.expiresAt) {
    activeToolState = null;
    return {};
  }
  // Non-expiring tool activity means the tool is still in progress. It is
  // cleared with the turn, or converted to a short hold when the tool ends.
  return {
    active_tool_name: activeToolState.name,
    active_tool_phase: activeToolState.phase,
    active_tool_event_id: activeToolState.eventId,
    active_tool_updated_at: new Date(activeToolState.updatedAt).toISOString(),
  };
}

export function readActiveToolHealthFields() {
  const now = Date.now();
  return {
    ...readAgentRunHealthFields(now),
    ...readActiveToolFields(now),
  };
}
