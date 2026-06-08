import type {
  ApprovalRequestModel,
  HistoryCellModel,
} from './state/tuiState';

export type MessageRole = HistoryCellModel['kind'];

export type MessageEntry = HistoryCellModel;

export type PendingUiState = {
  startedAt: number;
  phase: 'thinking' | 'replying' | 'interrupting';
  charCount: number;
};

export type PendingApproval = ApprovalRequestModel;

import type { ReviewResumeExtras } from '../localAgentProtocol';

export type ApprovalOption = {
  label: string;
  message: string;
  resume?: unknown;
  extras?: ReviewResumeExtras;
};

export type ActiveOperation = {
  name: string;
  label: string;
  detail: string;
  startedAt: number;
};

export type ResumeSessionSummary = {
  id: string;
  title: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  active: boolean;
};
