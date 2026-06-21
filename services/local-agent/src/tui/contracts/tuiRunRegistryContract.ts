export const TUI_RUN_REGISTRY_CONTRACT_VERSION = 1 as const;

export const TUI_RUN_PHASES = [
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

export const TUI_RUN_TERMINAL_PHASES = [
  'completed',
  'failed',
  'interrupted',
] as const;

export type TuiRunPhase = (typeof TUI_RUN_PHASES)[number];
export type TuiRunTerminalPhase = (typeof TUI_RUN_TERMINAL_PHASES)[number];

export type RunId = string;
export type SessionId = string;

export type TuiRunPendingReview = {
  requestId: RunId;
  reviewId: string;
  status: 'waiting' | 'answered' | 'interrupted';
};

export type TuiRunRegistryModel = {
  requestId: RunId;
  sessionId: SessionId;
  kind: 'chat' | 'studio';
  phase: TuiRunPhase;
  timelineEntryIds: string[];
  pendingReview?: TuiRunPendingReview;
  startedAt: number;
  updatedAt?: number;
  finishedAt?: number;
};

export type TuiRunRegistry = Record<RunId, TuiRunRegistryModel>;

export type TuiRunRegistryState = {
  runs: TuiRunRegistry;
  sessions: Record<SessionId, TuiRunRegistrySessionState>;
};

export type TuiRunRegistrySessionState = {
  activeRunId?: RunId;
};

export type TuiRunRegistryInput = {
  runId: RunId;
  sessionId: SessionId;
  phase: TuiRunPhase;
};

export function sessionIdFromRunId(runs: TuiRunRegistry, runId: RunId): SessionId | undefined {
  return runs[runId]?.sessionId;
}

export function isRunTerminal(phase: TuiRunPhase): phase is TuiRunTerminalPhase {
  return phase === 'completed' || phase === 'failed' || phase === 'interrupted';
}
