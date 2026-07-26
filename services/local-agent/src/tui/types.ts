import type {
  AgentMessageEntry,
  AgentSessionSummary,
} from '@pinpawo/agent-session';

export type MessageRole = Exclude<AgentMessageEntry['role'], 'subagent'>;

export type PendingUiState = {
  startedAt: number;
  phase: 'thinking' | 'replying' | 'interrupting';
  charCount: number;
};

export type ActiveOperation = {
  name: string;
  label: string;
  detail: string;
  startedAt: number;
};

export type ResumeSessionSummary = AgentSessionSummary;
