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

export type ApprovalOption = {
  label: string;
  message: string;
  resume?: unknown;
};

export type ActiveTool = {
  name: string;
  label: string;
  detail: string;
  startedAt: number;
};
