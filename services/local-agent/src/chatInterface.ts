import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';

export type LocalAgentInterfaceKind = 'tui' | 'app-chat';

export type LocalAgentInterfaceCapabilities = {
  humanReview: boolean;
  sessionAuthorization: boolean;
};

export type LocalAgentInterfaceContext = {
  threadId: string | null;
  kind: LocalAgentInterfaceKind | null;
  capabilities: LocalAgentInterfaceCapabilities;
};

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

export type LocalAgentClientMessage =
  | ChatRequestMessage
  | InterruptRequestMessage
  | NewSessionMessage
  | StudioRequestMessage
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

const NO_CAPABILITIES: LocalAgentInterfaceCapabilities = {
  humanReview: false,
  sessionAuthorization: false,
};

const TUI_CAPABILITIES: LocalAgentInterfaceCapabilities = {
  humanReview: true,
  sessionAuthorization: true,
};

const APP_CHAT_CAPABILITIES: LocalAgentInterfaceCapabilities = {
  humanReview: true,
  sessionAuthorization: false,
};

export function buildTuiChatThreadId(params: { petId: string; sessionSuffix: string }) {
  return `petbot:tui:pet:${params.petId}:${params.sessionSuffix}`;
}

export function buildStudioConversationId(params: { studioId: string; requestId: string }) {
  return `${params.studioId}:turn:${params.requestId}`;
}

export function buildAppChatThreadId(params: { petId: string; userId: string }) {
  return `petbot:chat:pet:${params.petId}:user:${params.userId}`;
}

export function readLocalAgentInterfaceKind(threadId: string | null): LocalAgentInterfaceKind | null {
  if (!threadId) return null;
  if (threadId.startsWith('petbot:tui:')) return 'tui';
  if (threadId.startsWith('petbot:chat:')) return 'app-chat';
  return null;
}

export function readLocalAgentInterfaceCapabilities(
  kind: LocalAgentInterfaceKind | null,
): LocalAgentInterfaceCapabilities {
  if (kind === 'tui') return TUI_CAPABILITIES;
  if (kind === 'app-chat') return APP_CHAT_CAPABILITIES;
  return NO_CAPABILITIES;
}

export function getCurrentLocalAgentInterface(): LocalAgentInterfaceContext {
  const runnableConfig = AsyncLocalStorageProviderSingleton.getRunnableConfig();
  const threadId = runnableConfig?.configurable?.thread_id;
  const normalizedThreadId = typeof threadId === 'string' && threadId ? threadId : null;
  const kind = readLocalAgentInterfaceKind(normalizedThreadId);
  return {
    threadId: normalizedThreadId,
    kind,
    capabilities: readLocalAgentInterfaceCapabilities(kind),
  };
}

export function readPendingInterrupt(snapshot: { tasks?: unknown }): Record<string, unknown> | null {
  const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
  for (const task of tasks) {
    if (!task || typeof task !== 'object') continue;
    const interrupts = Array.isArray((task as { interrupts?: unknown }).interrupts)
      ? (task as { interrupts: unknown[] }).interrupts
      : [];
    const first = interrupts[0];
    if (first && typeof first === 'object' && 'value' in first && first.value && typeof first.value === 'object') {
      return first.value as Record<string, unknown>;
    }
  }
  return null;
}

export function readHumanReviewActionRequests(interruptPayload: Record<string, unknown>) {
  return Array.isArray(interruptPayload.actionRequests)
    ? interruptPayload.actionRequests.filter((action): action is Record<string, unknown> =>
      Boolean(action && typeof action === 'object'),
    )
    : [];
}

export function isHumanReviewInterruptPayload(interruptPayload: Record<string, unknown>) {
  return interruptPayload.kind === 'human_review'
    || (
      Array.isArray(interruptPayload.actionRequests)
      && Array.isArray(interruptPayload.reviewConfigs)
    );
}

export function formatInterruptPrompt(interruptPayload: Record<string, unknown>) {
  if (typeof interruptPayload.prompt === 'string' && interruptPayload.prompt.trim()) {
    return interruptPayload.prompt.trim();
  }
  const descriptions = readHumanReviewActionRequests(interruptPayload).flatMap((action) => {
    if (typeof action.description === 'string' && action.description.trim()) {
      return [action.description.trim()];
    }
    const name = typeof action.name === 'string'
      ? action.name
      : typeof action.action === 'string'
        ? action.action
        : null;
    return name ? [`待审批动作：${name}`] : [];
  });
  return descriptions.length > 0
    ? descriptions.join('\n')
    : '当前流程需要你的确认，请直接回复继续或说明下一步。';
}

export function readShellReviewCommand(interruptPayload: Record<string, unknown>): string | null {
  if (interruptPayload.kind === 'confirm_shell' && typeof interruptPayload.command === 'string' && interruptPayload.command.trim()) {
    return interruptPayload.command.trim();
  }
  for (const action of readHumanReviewActionRequests(interruptPayload)) {
    const name = typeof action.name === 'string'
      ? action.name
      : typeof action.action === 'string'
        ? action.action
        : null;
    if (name !== 'shell' && name !== 'run_shell') continue;
    const args = action.args && typeof action.args === 'object'
      ? action.args as Record<string, unknown>
      : null;
    const command = args && typeof args.command === 'string' ? args.command.trim() : '';
    if (command) return command;
  }
  return null;
}

export function buildHumanReviewResume(decisions: Array<Record<string, unknown>>) {
  return { decisions };
}

function buildResumeFromUserText(message: string) {
  const text = message.trim();
  return buildHumanReviewResume([
    text
      ? { type: 'respond', message: text }
      : { type: 'reject' },
  ]);
}

function readFirstResumeDecisionType(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const decisions = Array.isArray(record.decisions) ? record.decisions : [];
  const first = decisions[0];
  if (!first || typeof first !== 'object') return null;
  const type = (first as Record<string, unknown>).type;
  return typeof type === 'string' ? type : null;
}

export function normalizeInterruptResume(
  interruptPayload: Record<string, unknown>,
  message: string,
  explicitResume: unknown,
) {
  if (isHumanReviewInterruptPayload(interruptPayload)) {
    return explicitResume !== undefined
      ? explicitResume
      : message.trim().startsWith('/allow')
        ? buildHumanReviewResume([{ type: 'approve' }])
        : buildResumeFromUserText(message);
  }

  if (message.trim().startsWith('/allow')) {
    return { action: 'continue' };
  }
  const explicitDecision = readFirstResumeDecisionType(explicitResume);
  if (explicitDecision === 'approve') {
    return { action: 'continue' };
  }
  if (explicitDecision === 'reject') {
    return { action: 'reject' };
  }
  return message;
}
