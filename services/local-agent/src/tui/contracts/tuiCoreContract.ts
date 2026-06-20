export const TUI_CORE_CONTRACT_VERSION = 1 as const;

export const TUI_CORE_TARGET_ACTIONS = {
  sessionSnapshotLoaded: 'session.snapshot.loaded',
} as const;

export const TUI_CORE_TIMELINE_ENTRY_TYPES = [
  'message',
  'operation',
] as const;

export const TUI_CORE_STATE_OWNERS = [
  'activeRun',
  'connection',
  'pendingReview',
  'runtime',
  'studioProgress',
  'tokenUsage',
] as const;

export const TUI_CORE_FORBIDDEN_SECONDARY_LOGS = [
  'transcript',
  'transcriptSnapshot',
] as const;

export const TUI_CORE_CONTRACT_RULES = [
  'timeline is the TUI projection of backend checkpoint messages',
  'timeline entries are limited to user messages, assistant messages, and tool operations',
  'pending review, runtime, studio progress, connection, token usage, and active run are state, not timeline messages',
  'session snapshots are reconciled through session.snapshot.loaded',
  'transcript and transcriptSnapshot must not be introduced as second message logs',
] as const;

export const TUI_CORE_DEFERRED_CONTRACT_GAPS = [
  {
    id: 'reconnect-server-completed-run',
    currentArea: 'TuiRuntimeController.reconnect',
    targetAction: TUI_CORE_TARGET_ACTIONS.sessionSnapshotLoaded,
    currentLegacyActions: ['session.replace_history'],
    followUp: ['CORE-4 Snapshot Adapter', 'CORE-5 Reconnect Reconciliation'],
  },
  {
    id: 'reconnect-pending-review',
    currentArea: 'TuiRuntimeController.reconnect',
    targetAction: TUI_CORE_TARGET_ACTIONS.sessionSnapshotLoaded,
    currentLegacyActions: [],
    followUp: ['CORE-4 Snapshot Adapter', 'CORE-5 Reconnect Reconciliation'],
  },
  {
    id: 'resume-session-snapshot',
    currentArea: 'TuiRuntimeController.resumeSession',
    targetAction: TUI_CORE_TARGET_ACTIONS.sessionSnapshotLoaded,
    currentLegacyActions: ['session.clear', 'session.replace_history'],
    followUp: ['CORE-4 Snapshot Adapter', 'CORE-5 Reconnect Reconciliation'],
  },
] as const;

export const TUI_CORE_DEFERRED_REDUCER_GAPS = [
  {
    id: 'completed-event-missing-active-pointer',
    currentArea: 'tuiStateReducer event.received(message.completed)',
    target: 'terminal events update runs[requestId] even when session.activeRun is missing',
    currentLegacyPaths: ['session.activeRun pointer gate', 'runRoute fallback'],
    followUp: ['CORE-3 Run Registry', 'CORE-5 Reconnect Reconciliation'],
  },
] as const;

export type TuiCoreTimelineSource = 'checkpoint' | 'live-event' | 'local-input';

export type TuiCoreMessageTimelineEntry = {
  id: string;
  type: 'message';
  role: 'user' | 'assistant';
  text: string;
  status: 'streaming' | 'completed';
  source: TuiCoreTimelineSource;
  requestId?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type TuiCoreOperationTimelineEntry = {
  id: string;
  type: 'operation';
  requestId: string;
  operationKey: string;
  phase: 'started' | 'updated' | 'completed' | 'failed' | 'interrupted';
  source: TuiCoreTimelineSource;
  title?: string;
  summary?: string;
  startedAt?: number;
  updatedAt?: number;
  completedAt?: number;
};

export type TuiCoreTimelineEntry =
  | TuiCoreMessageTimelineEntry
  | TuiCoreOperationTimelineEntry;

export type TuiCorePendingReview = {
  requestId: string;
  reviewId: string;
  status: 'waiting' | 'answered' | 'interrupted';
};

export type TuiCoreRunSnapshot = {
  requestId: string;
  sessionId: string;
  kind: 'chat' | 'studio';
  phase:
    | 'starting'
    | 'thinking'
    | 'using_tool'
    | 'streaming'
    | 'waiting_human'
    | 'interrupting'
    | 'completed'
    | 'failed'
    | 'interrupted';
  timelineEntryIds: string[];
  pendingReview?: TuiCorePendingReview;
  startedAt?: number;
  updatedAt?: number;
  finishedAt?: number;
};

export type TuiCoreRuntimeSnapshot = {
  model?: string;
  cwd?: string;
  stateRoot?: string;
  contextWindow?: number;
};

export type TuiCoreTokenUsageSnapshot = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  contextWindow?: number;
  updatedAt?: string;
};

export type TuiCoreSessionSnapshot = {
  sessionId: string;
  kind: 'chat' | 'studio';
  timeline: TuiCoreTimelineEntry[];
  runs: TuiCoreRunSnapshot[];
  activeRunId?: string;
  pendingReviewId?: string;
  runtime?: TuiCoreRuntimeSnapshot;
  tokenUsage?: TuiCoreTokenUsageSnapshot;
};

export type TuiCoreSessionSnapshotLoadedAction = {
  type: typeof TUI_CORE_TARGET_ACTIONS.sessionSnapshotLoaded;
  source: 'startup' | 'reconnect' | 'resume';
  snapshot: TuiCoreSessionSnapshot;
};
