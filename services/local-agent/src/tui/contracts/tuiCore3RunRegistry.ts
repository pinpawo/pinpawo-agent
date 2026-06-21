export const TUI_CORE3_CONTRACT_VERSION = 3 as const;

export const TUI_CORE3_RUN_PHASES = [
  'starting',
  'thinking',
  'using_tool',
  'streaming',
  'waiting_human',
  'interrupting',
  'completed',
  'failed',
  'interrupted',
] as const;

export const TUI_CORE3_RUN_TERMINAL_EVENTS = [
  'completed',
  'failed',
  'interrupted',
] as const;

export const TUI_CORE3_DEFERRED_RUN_REGISTRY_GAPS = [
  {
    id: 'run-registry-routing-migration',
    currentArea: 'tuiState + reducer',
    target: 'route events via runs[requestId].sessionId',
    currentLegacyPaths: ['runRoute lookup', 'session.activeRun pointer only'],
    followUp: ['CORE-7 legacy mirror removal'],
  },
  {
    id: 'run-route-removal',
    currentArea: 'global TuiState model',
    target: 'replace TuiState.runRoute',
    currentLegacyPaths: ['tuiState.runRoute'],
    followUp: ['CORE-7 legacy mirror removal'],
  },
  {
    id: 'active-run-entity-migration',
    currentArea: 'session state model',
    target: 'introduce TuiState.runs + SessionModel.activeRunId',
    currentLegacyPaths: ['SessionModel.activeRun as full run entity'],
    followUp: ['CORE-7 legacy mirror removal'],
  },
] as const;

export type TuiCore3RunPhase = (typeof TUI_CORE3_RUN_PHASES)[number];
export type TuiCore3RunTerminalPhase = (typeof TUI_CORE3_RUN_TERMINAL_EVENTS)[number];

export type RunId = string;
export type SessionId = string;

export type TuiCore3PendingReview = {
  requestId: RunId;
  reviewId: string;
  status: 'waiting' | 'answered' | 'interrupted';
};

export type TuiCore3RunModel = {
  requestId: RunId;
  sessionId: SessionId;
  kind: 'chat' | 'studio';
  phase: TuiCore3RunPhase;
  timelineEntryIds: string[];
  pendingReview?: TuiCore3PendingReview;
  startedAt: number;
  updatedAt?: number;
  finishedAt?: number;
};

export type TuiCore3RunRegistry = Record<RunId, TuiCore3RunModel>;

export type TuiCore3State = {
  runs: TuiCore3RunRegistry;
  sessions: Record<SessionId, TuiCore3SessionState>;
};

export type TuiCore3SessionState = {
  activeRunId?: RunId;
};

export type TuiCore3RunRegistryInput = {
  runId: RunId;
  sessionId: SessionId;
  phase: TuiCore3RunPhase;
};

export function sessionIdFromRunId(runs: TuiCore3RunRegistry, runId: RunId): SessionId | undefined {
  return runs[runId]?.sessionId;
}

export function isRunTerminal(phase: TuiCore3RunPhase): phase is TuiCore3RunTerminalPhase {
  return phase === 'completed' || phase === 'failed' || phase === 'interrupted';
}
