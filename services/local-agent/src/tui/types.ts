export type MessageRole = 'user' | 'assistant' | 'system';

export type MessageEntry = {
  id: string;
  role: MessageRole;
  timestamp?: string;
  text: string;
};

export type PendingUiState = {
  startedAt: number;
  phase: 'thinking' | 'replying' | 'interrupting';
  charCount: number;
};

export type PendingInterrupt = {
  kind: string;
  requestId: string;
  prompt: string;
  payload: Record<string, unknown>;
  /** Studio 模式下,触发本次 HITL 的 pet id;chat 路径下为 undefined */
  petId?: string;
};

export type InterruptOption = {
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
