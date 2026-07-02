import type {
  ApprovalRequestModel,
  MessageCellModel,
} from './state/tuiState';

export type MessageRole = MessageCellModel['kind'];

export type MessageEntry = MessageCellModel;

export type PendingUiState = {
  startedAt: number;
  phase: 'thinking' | 'replying' | 'interrupting';
  charCount: number;
};

export type PendingApproval = ApprovalRequestModel;

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

export type WorkspaceSummary = {
  id: string;
  name: string;
  rootPath: string;
  active: boolean;
  createdAt?: string;
  lastOpenedAt?: string;
};
