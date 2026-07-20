import type { TokenUsageSnapshot } from '@pinpawo/pet-agent';
import type {
  LocalAgentOperationPhase,
  LocalAgentOperationRaw,
} from './events/localAgentRuntimeEvent';
import type { ReviewAction } from './reviewAction';

export const LOCAL_AGENT_SESSION_SNAPSHOT_VERSION = 3 as const;

export type LocalAgentMessageEntry = {
  id: string;
  type: 'message';
  role: 'user' | 'assistant' | 'system' | 'subagent';
  text: string;
  status: 'streaming' | 'completed';
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
  createdAt?: string;
};

export type LocalAgentReviewAction = ReviewAction & {
  petId?: string;
};

export type LocalAgentRunActivity =
  | 'thinking'
  | 'using_tool'
  | 'streaming';

type LocalAgentRunViewBase = {
  requestId: string;
  startedAt?: number;
  updatedAt?: number;
};

export type LocalAgentRunView =
  | LocalAgentRunViewBase & {
      state: 'running';
      activity: LocalAgentRunActivity;
    }
  | LocalAgentRunViewBase & {
      state: 'waiting_review';
      reviewAction: LocalAgentReviewAction;
    }
  | LocalAgentRunViewBase & {
      state: 'interrupting';
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
  petsDir?: string;
  studioWikiBaseDir?: string;
  contextWindow?: number;
};

export type LocalAgentSession = {
  sessionId: string;
  kind: 'chat' | 'studio';
  actor?: LocalAgentActorView;
  timeline: LocalAgentTimelineEntry[];
  activeRun: LocalAgentRunView | null;
  runtime?: LocalAgentRuntimeView;
  tokenUsage?: TokenUsageSnapshot;
};

export type LocalAgentSessionSnapshot = {
  version: typeof LOCAL_AGENT_SESSION_SNAPSHOT_VERSION;
  session: LocalAgentSession;
};

export type LocalAgentSessionSummary = {
  id: string;
  kind: LocalAgentSession['kind'];
  title: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  active: boolean;
};
