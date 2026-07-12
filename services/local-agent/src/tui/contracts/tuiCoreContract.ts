import type { ReviewSpec, TokenUsageSnapshot } from '@pinpawo/pet-agent';

export const TUI_CORE_CONTRACT_VERSION = 2 as const;

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
  'runs',
  'runtime',
  'tokenUsage',
] as const;

export const TUI_CORE_FORBIDDEN_SECONDARY_LOGS = [
  'session.history',
  'messageOnlyView',
  'transcript',
  'transcriptSnapshot',
] as const;

export const TUI_CORE_CONTRACT_RULES = [
  'timeline is the ordered TUI projection of checkpoint messages and live presentation events',
  'timeline entries are limited to user, assistant, system, and subagent messages plus tool operations',
  'pending review, runtime, connection, token usage, and active run are state, not timeline messages',
  'session snapshots are reconciled through session.snapshot.loaded',
  'session.history, message-only views, transcript, and transcriptSnapshot must not be introduced as second message logs',
] as const;

export type TuiCoreTimelineSource = 'checkpoint' | 'live-event' | 'local-input';

export type TuiCoreMessageTimelineEntry = {
  id: string;
  type: 'message';
  role: 'user' | 'assistant' | 'system' | 'subagent';
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
  interruptId?: string;
  reviewId: string;
  status: 'waiting' | 'answered' | 'interrupted';
  review?: ReviewSpec;
  reviews?: ReviewSpec[];
  petId?: string;
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
  workspaceId?: string;
  workspaceName?: string;
  workspaceRoot?: string;
  stateRoot?: string;
  studioConfigPath?: string;
  studioDueRunsPath?: string;
  studioConfigSource?: string;
  studioConfigActivePath?: string;
  legacyStudioConfigPath?: string;
  petsDir?: string;
  studioWikiBaseDir?: string;
  contextWindow?: number;
};

export type TuiCoreTokenUsageSnapshot = TokenUsageSnapshot;

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
  source: 'startup' | 'reconnect' | 'resume' | 'reconcile';
  snapshot: TuiCoreSessionSnapshot;
  now?: number;
};
