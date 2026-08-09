/**
 * Studio API contract (#561 Phase 1).
 *
 * 这里只定义**形状与解析**,不含实现。HTTP 层在后续 Phase 实现。
 *
 * 对外协议是薄的一层:
 * - 一个 POST 提交 user request;
 * - 一条 SSE 推送 **wiki 知识库变更**。
 *
 * SSE 只推 wiki —— 对外暴露的是 Studio 的**产出**,不是执行过程。task 调度、
 * pet invocation、工具执行这些编排细节不出协议边界。
 *
 * 边界声明(与 #570 的关系):run/task/pet/invocation 的 correlation 归本 issue
 * 所有;通用的 agent invocation / interaction / state 协议归
 * `@pinpawo/agent-contracts`,本文件不重新定义。
 */

/* ─────────────── Correlation identity ─────────────── */

/**
 * 一次 pet 调度的关联身份。#561 要求 Studio 事件能还原
 * `runId + taskId + petId + invocationId`。
 *
 * `taskId` 用稳定字符串而非裸 `taskIndex`,以便 re-plan 后仍可寻址;
 * `taskIndex` 保留为同一 run 内的展示序号。
 */
export type StudioInvocationIdentity = {
  studioId: string;
  runId: string;
  conversationId: string;
  taskId: string;
  taskIndex: number;
  petId: string;
  invocationId: string;
};

/* ─────────────── Cancel scope ─────────────── */

/**
 * 取消范围必须显式。取消一个 invocation 不得误停其他并行任务,
 * 因此 scope 是协议的一部分,而不是由服务端猜测。
 */
export type StudioCancelScope =
  | { scope: 'invocation'; runId: string; invocationId: string }
  | { scope: 'task'; runId: string; taskId: string }
  | { scope: 'run'; runId: string };

/* ─────────────── Wiki change event (SSE payload) ─────────────── */

/**
 * SSE 推送的唯一事件。沿用 orchestrator 既有 `wiki_changed` 的形状:
 * 只说**哪些路径变了**,不带内容或摘要——需要内容的消费者自己去读 wiki。
 */
export type StudioWikiChangedEvent = {
  type: 'wiki_changed';
  runId: string;
  conversationId: string;
  changedPaths: string[];
  occurredAt: string;
};

/* ─────────────── Errors ─────────────── */

export const STUDIO_ERROR_CODES = [
  'studio_not_configured',
  'studio_mode_required',
  'run_not_found',
  'cancelled',
  'internal',
] as const;

export type StudioErrorCode = (typeof STUDIO_ERROR_CODES)[number];

export type StudioError = {
  code: StudioErrorCode;
  message: string;
};

export function isStudioErrorCode(value: unknown): value is StudioErrorCode {
  return typeof value === 'string'
    && (STUDIO_ERROR_CODES as readonly string[]).includes(value);
}

/* ─────────────── Parsers ─────────────── */

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readNonEmptyString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * 解析 cancel 的 scope。非法或缺失 scope 返回 null 而不是猜一个默认值——
 * 猜测会导致误停其他并行任务。
 */
export function parseStudioCancelScope(value: unknown): StudioCancelScope | null {
  const record = asRecord(value);
  if (!record) return null;
  const runId = readNonEmptyString(record, 'runId');
  if (!runId) return null;

  if (record.scope === 'run') {
    return { scope: 'run', runId };
  }
  if (record.scope === 'task') {
    const taskId = readNonEmptyString(record, 'taskId');
    return taskId ? { scope: 'task', runId, taskId } : null;
  }
  if (record.scope === 'invocation') {
    const invocationId = readNonEmptyString(record, 'invocationId');
    return invocationId ? { scope: 'invocation', runId, invocationId } : null;
  }
  return null;
}

export function parseStudioInvocationIdentity(value: unknown): StudioInvocationIdentity | null {
  const record = asRecord(value);
  if (!record) return null;
  const studioId = readNonEmptyString(record, 'studioId');
  const runId = readNonEmptyString(record, 'runId');
  const conversationId = readNonEmptyString(record, 'conversationId');
  const taskId = readNonEmptyString(record, 'taskId');
  const petId = readNonEmptyString(record, 'petId');
  const invocationId = readNonEmptyString(record, 'invocationId');
  const taskIndex = record.taskIndex;
  if (!studioId || !runId || !conversationId || !taskId || !petId || !invocationId) return null;
  if (typeof taskIndex !== 'number' || !Number.isInteger(taskIndex) || taskIndex < 0) return null;
  return { studioId, runId, conversationId, taskId, taskIndex, petId, invocationId };
}

/**
 * Studio 的 checkpoint/thread namespace。必须能区分 conversation、run、task、
 * pet 和 invocation——同一个常驻 graph 对不同 threadId 的并发 invoke 才在契约上合法。
 */
export function buildStudioThreadId(identity: StudioInvocationIdentity): string {
  return [
    'studio', identity.studioId,
    'thread', identity.conversationId,
    'run', identity.runId,
    'task', identity.taskId,
    'pet', identity.petId,
    'invocation', identity.invocationId,
  ].join(':');
}
