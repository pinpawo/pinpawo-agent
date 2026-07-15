import type { LocalAgentMessageEntry } from '../localAgentSession';

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

export type ResumeSessionSummary = {
  id: string;
  kind?: 'chat' | 'studio';
  title: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  active: boolean;
};
