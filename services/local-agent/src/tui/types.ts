import type {
  LocalAgentMessageEntry,
  LocalAgentSessionSummary,
} from '../localAgentSession';

export type MessageRole = Exclude<LocalAgentMessageEntry['role'], 'subagent'>;

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

export type ResumeSessionSummary = LocalAgentSessionSummary;
