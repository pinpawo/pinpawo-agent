import type { TokenUsageSnapshot } from '@pinpawo/pet-agent';
import type {
  LocalAgentOperationPhase,
  LocalAgentOperationRaw,
} from './events/localAgentRuntimeEvent';
import type { ReviewAction } from './reviewAction';

export const LOCAL_AGENT_SESSION_SNAPSHOT_VERSION = 1 as const;

export type LocalAgentTimelineSource = 'checkpoint' | 'live-event' | 'local-input';

export type LocalAgentMessageEntry = {
  id: string;
  type: 'message';
  role: 'user' | 'assistant' | 'system' | 'subagent';
  text: string;
  status: 'streaming' | 'completed';
  source: LocalAgentTimelineSource;
  requestId?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type LocalAgentOperationEntry = {
  id: string;
  type: 'operation';
  requestId: string;
  operationKey: string;
  kind: string;
  title: string;
  phase: LocalAgentOperationPhase;
  source: LocalAgentTimelineSource;
  target?: string;
  summary?: string;
  details?: Record<string, unknown>;
  operationSource?: {
    provider: 'toolkit' | 'toolset' | 'runtime';
    name: string;
    toolName?: string;
    callId?: string;
  };
  startedAt?: number;
  updatedAt?: number;
  completedAt?: number;
  /** Trusted local clients may retain raw payloads; remote transports must strip them. */
  raw?: LocalAgentOperationRaw;
};

export type LocalAgentTimelineEntry =
  | LocalAgentMessageEntry
  | LocalAgentOperationEntry;

export type LocalAgentSessionMessageInput = {
  id?: string;
  role: LocalAgentMessageEntry['role'];
  text: string;
  requestId?: string;
  source?: LocalAgentTimelineSource;
  createdAt?: string;
};

export type LocalAgentReviewAction = ReviewAction & {
  petId?: string;
};

export type LocalAgentRunPhase =
  | 'thinking'
  | 'using_tool'
  | 'streaming'
  | 'waiting_human'
  | 'interrupting';

export type LocalAgentRun = {
  requestId: string;
  phase: LocalAgentRunPhase;
  reviewAction?: LocalAgentReviewAction;
  startedAt?: number;
  updatedAt?: number;
};

export type LocalAgentActorView = {
  label: string;
  summary: string;
};

export type LocalAgentRuntimeView = {
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

export type LocalAgentSession = {
  sessionId: string;
  kind: 'chat' | 'studio';
  actor?: LocalAgentActorView;
  timeline: LocalAgentTimelineEntry[];
  activeRun: LocalAgentRun | null;
  runtime?: LocalAgentRuntimeView;
  tokenUsage?: TokenUsageSnapshot;
};

export type LocalAgentSessionSnapshot = {
  version: typeof LOCAL_AGENT_SESSION_SNAPSHOT_VERSION;
  session: LocalAgentSession;
};
