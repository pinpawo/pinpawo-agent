export type ChatRequestMessage = {
  type: 'chat_request';
  requestId: string;
  message: string;
  petId?: string;
  userId?: string;
  resume?: unknown;
};

export type InterruptRequestMessage = {
  type: 'interrupt_request';
  requestId: string;
};

export type NewSessionMessage = {
  type: 'new_session';
  petId?: string;
  userId?: string;
};

export type StudioRequestMessage = {
  type: 'studio_request';
  requestId: string;
  userRequest: string;
  /** 可选:overrides 默认的 conversation 命名,影响 wiki 子目录 */
  conversationId?: string;
};

export type HumanReviewResponseMessage = {
  type: 'human_review_response';
  requestId: string;
  message: string;
  resume?: unknown;
};

export type LocalAgentClientMessage =
  | ChatRequestMessage
  | InterruptRequestMessage
  | NewSessionMessage
  | StudioRequestMessage
  | HumanReviewResponseMessage
  | { type: 'ping' };

export type ToolLogPhase = 'start' | 'end' | 'complete' | 'error' | 'event' | 'interrupt';

export type LocalAgentServerMessage =
  | { type: 'pong' }
  | { type: 'chat_token'; requestId: string; token: string }
  | {
      type: 'tool_log';
      requestId: string;
      phase: ToolLogPhase;
      toolName: string;
      toolCallId?: string;
      input?: string;
      output?: string;
      error?: string;
    }
  | {
      type: 'human_interrupt';
      requestId: string;
      /** Studio 模式下表示是哪个 pet 在问;chat 路径不带此字段 */
      petId?: string;
      prompt: string;
      payload: Record<string, unknown>;
    }
  | { type: 'interrupting'; requestId: string; message?: string }
  | { type: 'interrupted'; requestId: string; message?: string }
  | { type: 'system_notice'; requestId: string; message: string }
  | {
      type: 'chat_response';
      requestId: string;
      message: string;
      mood: string | null;
      topic: string | null;
      tags: string[];
    }
  | {
      /**
       * Studio orchestrator 编排进度事件。turn_started / plan_set /
       * dispatch_started / task_status_changed / dispatch_finished /
       * wiki_updated / turn_finished 等。客户端按 `event.type` 分情况渲染
       * (StudioTurnEvent 形态定义在 @pinpawo/pet-agent 中)。
       */
      type: 'studio_turn_event';
      requestId: string;
      event: Record<string, unknown>;
    }
  | {
      type: 'studio_response';
      requestId: string;
      outcome: 'done' | 'stopped';
      reply: string;
      finalDispatchId?: string;
      reason?: string;
    }
  | { type: 'studio_error'; requestId: string; message: string }
  | { type: 'error'; requestId: string; message: string };

type WsLike = {
  readyState: number;
  send(data: string): unknown;
};

const WS_OPEN = 1;

function readJsonRecord(raw: unknown): Record<string, unknown> | null {
  try {
    const text = typeof raw === 'string' ? raw : raw instanceof Buffer ? raw.toString() : String(raw);
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function readString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function readOptionalString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function readRecord(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readStringArray(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : null;
}

export function parseLocalAgentClientMessage(raw: unknown): LocalAgentClientMessage | null {
  const record = readJsonRecord(raw);
  if (!record) return null;
  const type = readString(record, 'type');
  if (type === 'ping') return { type: 'ping' };
  if (type === 'chat_request') {
    const requestId = readString(record, 'requestId');
    const message = readString(record, 'message');
    if (!requestId || message == null) return null;
    return {
      type,
      requestId,
      message,
      petId: readOptionalString(record, 'petId'),
      userId: readOptionalString(record, 'userId'),
      ...(record.resume !== undefined ? { resume: record.resume } : {}),
    };
  }
  if (type === 'human_review_response') {
    const requestId = readString(record, 'requestId');
    const message = readString(record, 'message');
    if (!requestId || message == null) return null;
    return {
      type,
      requestId,
      message,
      ...(record.resume !== undefined ? { resume: record.resume } : {}),
    };
  }
  if (type === 'interrupt_request') {
    const requestId = readString(record, 'requestId');
    return requestId ? { type, requestId } : null;
  }
  if (type === 'new_session') {
    return {
      type,
      petId: readOptionalString(record, 'petId'),
      userId: readOptionalString(record, 'userId'),
    };
  }
  if (type === 'studio_request') {
    const requestId = readString(record, 'requestId');
    const userRequest = readString(record, 'userRequest');
    if (!requestId || userRequest == null) return null;
    return {
      type,
      requestId,
      userRequest,
      conversationId: readOptionalString(record, 'conversationId'),
    };
  }
  return null;
}

export function parseLocalAgentServerMessage(raw: unknown): LocalAgentServerMessage | null {
  const record = readJsonRecord(raw);
  if (!record) return null;
  const type = readString(record, 'type');
  if (type === 'pong') return { type };
  const requestId = readString(record, 'requestId');
  if (!requestId) return null;
  if (type === 'chat_token') {
    const token = readString(record, 'token');
    return token == null ? null : { type, requestId, token };
  }
  if (type === 'tool_log') {
    const phase = readString(record, 'phase');
    const toolName = readString(record, 'toolName');
    if (!phase || !isToolLogPhase(phase) || !toolName) return null;
    return {
      type,
      requestId,
      phase,
      toolName,
      toolCallId: readOptionalString(record, 'toolCallId'),
      input: readOptionalString(record, 'input'),
      output: readOptionalString(record, 'output'),
      error: readOptionalString(record, 'error'),
    };
  }
  if (type === 'human_interrupt') {
    const prompt = readString(record, 'prompt');
    const payload = readRecord(record, 'payload');
    if (prompt == null || !payload) return null;
    return {
      type,
      requestId,
      petId: readOptionalString(record, 'petId'),
      prompt,
      payload,
    };
  }
  if (type === 'interrupting' || type === 'interrupted' || type === 'studio_error' || type === 'error') {
    return {
      type,
      requestId,
      message: readOptionalString(record, 'message') ?? (type.endsWith('error') ? '' : undefined),
    } as LocalAgentServerMessage;
  }
  if (type === 'system_notice') {
    const message = readString(record, 'message');
    return message == null ? null : { type, requestId, message };
  }
  if (type === 'chat_response') {
    const message = readString(record, 'message');
    const tags = readStringArray(record, 'tags');
    if (message == null || !tags) return null;
    return {
      type,
      requestId,
      message,
      mood: readOptionalString(record, 'mood') ?? null,
      topic: readOptionalString(record, 'topic') ?? null,
      tags,
    };
  }
  if (type === 'studio_turn_event') {
    const event = readRecord(record, 'event');
    return event ? { type, requestId, event } : null;
  }
  if (type === 'studio_response') {
    const outcome = readString(record, 'outcome');
    const reply = readString(record, 'reply');
    if ((outcome !== 'done' && outcome !== 'stopped') || reply == null) return null;
    return {
      type,
      requestId,
      outcome,
      reply,
      finalDispatchId: readOptionalString(record, 'finalDispatchId'),
      reason: readOptionalString(record, 'reason'),
    };
  }
  return null;
}

export function sendLocalAgentMessage(ws: WsLike, message: LocalAgentServerMessage | LocalAgentClientMessage) {
  if (ws.readyState !== WS_OPEN) {
    return false;
  }
  ws.send(JSON.stringify(message));
  return true;
}

function isToolLogPhase(value: string): value is ToolLogPhase {
  return value === 'start'
    || value === 'end'
    || value === 'complete'
    || value === 'error'
    || value === 'event'
    || value === 'interrupt';
}
