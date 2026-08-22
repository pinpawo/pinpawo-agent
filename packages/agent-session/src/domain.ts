import type {
  ToolAuthorizationMode,
  ToolAuthorizationSafetyLevel,
  TokenUsageSnapshot,
} from '@pinpawo/agent-contracts';
import type {
  AgentOperationPhase,
  AgentOperationRaw,
} from './events';
import type { PendingInterruptProjection } from './review';

export const AGENT_SESSION_SNAPSHOT_VERSION = 5 as const;

export type AgentMessageEntry = {
  id: string;
  type: 'message';
  role: 'user' | 'assistant' | 'system' | 'subagent';
  text: string;
  status: 'streaming' | 'completed';
  requestId?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type AgentOperationEntry = {
  id: string;
  type: 'operation';
  requestId: string;
  operationKey: string;
  kind: string;
  title: string;
  phase: AgentOperationPhase;
  target?: string;
  summary?: string;
  details?: Record<string, unknown>;
  operationSource?: {
    provider: 'toolkit' | 'runtime';
    name: string;
    toolName?: string;
    callId?: string;
  };
  startedAt?: number;
  updatedAt?: number;
  completedAt?: number;
  /** Transient tool payload retained by the canonical projection when supplied. */
  raw?: AgentOperationRaw;
};

export type AgentTimelineEntry =
  | AgentMessageEntry
  | AgentOperationEntry;

export type AgentSessionMessageInput = {
  id?: string;
  role: AgentMessageEntry['role'];
  text: string;
  requestId?: string;
  createdAt?: string;
};

export type AgentRunActivity =
  | 'thinking'
  | 'using_tool'
  | 'streaming';

/** A compact, display-ready projection of the active delegation plan. */
export type AgentPlan = {
  items: AgentPlanItem[];
};

export type AgentPlanItem = {
  id: string;
  capability: string;
  task: string;
  status: 'completed' | 'active' | 'pending';
};

type AgentRunTiming = {
  startedAt?: number;
  updatedAt?: number;
};

export type AgentRunView =
  | AgentRunTiming & {
      requestId: string;
      state: 'running';
      activity: AgentRunActivity;
    }
  | AgentRunTiming & {
      requestId: string;
      state: 'interrupting';
    };

export type AgentActorView = {
  label: string;
  summary: string;
};

export type AgentInputModality = 'text' | 'image';

export type AgentModelProfileSummary = {
  id: string;
  label: string;
  provider?: string;
  model?: string;
  endpointHost?: string;
  contextWindowTokens?: number;
  inputModalities: AgentInputModality[];
  available: boolean;
  compatible: boolean;
  issues: string[];
};

export type AgentRuntimeView = {
  modelProfileId?: string;
  modelProfileLabel?: string;
  modelProfileAvailable?: boolean;
  modelProfileCompatible?: boolean;
  modelProfileIssues?: string[];
  model?: string;
  inputModalities?: AgentInputModality[];
  requiredInputModalities?: AgentInputModality[];
  /** @deprecated Use toolAuthorizationMode for new consumers. */
  globalReviewPolicyMode?: ToolAuthorizationMode;
  autoAuthorizationSafetyLevel?: ToolAuthorizationSafetyLevel;
  toolAuthorizationMode?: ToolAuthorizationMode;
  cwd?: string;
  workspaceId?: string;
  workspaceName?: string;
  workspaceRoot?: string;
  stateRoot?: string;
  petsDir?: string;
  contextWindow?: number;
};

export type AgentSession = {
  sessionId: string;
  kind: 'chat';
  actor?: AgentActorView;
  timeline: AgentTimelineEntry[];
  activeRun: AgentRunView | null;
  pendingInterrupt: PendingInterruptProjection | null;
  /** Ephemeral delegation plan, separate from the durable conversation timeline. */
  currentPlan?: AgentPlan | null;
  runtime?: AgentRuntimeView;
  /** Latest completed run usage, when the provider reports it. */
  tokenUsage?: TokenUsageSnapshot;
  /** Process-observed cumulative usage for this session. */
  sessionTokenUsage?: TokenUsageSnapshot & { scope: 'session' };
};

export type AgentSessionSummary = {
  id: string;
  kind: AgentSession['kind'];
  title: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  active: boolean;
};
