/**
 * Studio API contract (#561 Phase 1).
 *
 * 这里只定义**形状与解析**,不含实现。Phase 1 的目标是把 Studio 的命令、
 * 查询、事件和错误边界固定下来,并保证 schema 从第一版就允许多个同时存在的
 * run / task / invocation——即使 V1 的有效并发度仍是 1。
 *
 * 边界声明(与 #570 的关系):
 * - 这些类型是 **Studio-only** 的编排协议(run/task/pet/invocation correlation、
 *   scheduler、lease、recovery),按 #561 的分工归本 issue 所有。
 * - 通用的 agent invocation / interaction / state 协议归 `@pinpawo/agent-contracts`
 *   所有,本文件**不重新定义**它们。HITL 应答仍复用 canonical
 *   `HumanReviewResponse`,这里只增加把它路由到某个 invocation 的寻址信息。
 */

/* ─────────────── Correlation identity ─────────────── */

/**
 * 一次 pet 调度的完整关联身份。#561 要求所有 Studio/pet 事件都能还原
 * `runId + taskId + petId + invocationId`。
 *
 * `taskId` 使用稳定字符串而非裸 `taskIndex`,以便 re-plan 后仍可寻址;
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

export type StudioRunIdentityRef = Pick<StudioInvocationIdentity, 'studioId' | 'runId'>;

/* ─────────────── Cancel scope ─────────────── */

/**
 * 取消范围必须显式。#561 验收要求取消一个 invocation 不得误停其他并行任务,
 * 因此 scope 是协议的一部分,而不是由服务端猜测。
 */
export type StudioCancelScope =
  | { scope: 'invocation'; runId: string; invocationId: string }
  | { scope: 'task'; runId: string; taskId: string }
  | { scope: 'run'; runId: string };

/* ─────────────── Commands ─────────────── */

export type StudioSubmitCommand = {
  command: 'studio.run.submit';
  requestId: string;
  userRequest: string;
  /** 外部调度器可显式指定,用于跨重试维持同一次运行的幂等主键。 */
  runId?: string;
  conversationId?: string;
};

/**
 * HITL 应答。`invocationId` 是新增的寻址字段——它取代"每连接一个 current
 * review"的单槽模型,使同时存在的多个 review 可以被区分。
 *
 * `response` 沿用 `@pinpawo/agent-contracts` 的 canonical `HumanReviewResponse`,
 * 本契约不复制其结构。
 */
export type StudioReviewRespondCommand = {
  command: 'studio.review.respond';
  requestId: string;
  runId: string;
  invocationId: string;
  reviewId: string;
  /** canonical HumanReviewResponse,由 agent-contracts 解析。 */
  response: unknown;
};

export type StudioCancelCommand = {
  command: 'studio.cancel';
  requestId: string;
} & StudioCancelScope;

export type StudioCommand =
  | StudioSubmitCommand
  | StudioReviewRespondCommand
  | StudioCancelCommand;

/* ─────────────── Queries ─────────────── */

/**
 * 查询是幂等只读的。`studio.status` 返回 host 级事实(mode、planner/worker、
 * capacity),`studio.runs.list` / `studio.run.get` 返回 run 与 task 状态。
 */
export type StudioQuery =
  | { query: 'studio.status'; requestId: string }
  | { query: 'studio.runs.list'; requestId: string; status?: StudioRunStatusFilter; limit?: number }
  | { query: 'studio.run.get'; requestId: string; runId: string };

export type StudioRunStatusFilter =
  | 'planning' | 'running' | 'blocked' | 'done' | 'failed' | 'cancelled';

/* ─────────────── Capacity / lease projection ─────────────── */

/**
 * capacity 以**计数**表达,不是 `busy: boolean`。#561 明确禁止把"整个 Studio
 * 同时只有一个 request"固化进接口。V1 可以让 `maxConcurrent` 为 1。
 */
export type StudioCapacitySnapshot = {
  maxConcurrent: number;
  inUse: number;
};

export type StudioPetCapacitySnapshot = StudioCapacitySnapshot & {
  petId: string;
};

/**
 * 一个已发放的 lease。completion / failure / cancel 只释放对应 lease,
 * 不得误释放同 pet 的其他 invocation。
 */
export type StudioLeaseSnapshot = {
  identity: StudioInvocationIdentity;
  status: 'queued' | 'running' | 'waiting_review' | 'terminal';
  acquiredAt: string;
  releasedAt?: string;
};

export type StudioStatusSnapshot = {
  studioId: string;
  plannerPetId: string;
  workerPetIds: readonly string[];
  host: StudioCapacitySnapshot;
  pets: readonly StudioPetCapacitySnapshot[];
  leases: readonly StudioLeaseSnapshot[];
};

/* ─────────────── Events ─────────────── */

/**
 * 每个事件都携带完整 correlation identity。顺序保证只在**单个 invocation 内**
 * 成立;跨 invocation 的全局到达顺序不作保证,因此消费者必须按 identity 分组,
 * 不能假设一条全局有序流。
 *
 * `cursor` 单调递增,供 reconnect 时从 server 断点续订。
 */
export type StudioEventEnvelope<TPayload = unknown> = {
  cursor: number;
  occurredAt: string;
  identity: StudioInvocationIdentity | StudioRunIdentityRef;
  payload: TPayload;
};

export type StudioEventKind =
  | 'run.status_changed'
  | 'task.status_changed'
  | 'invocation.started'
  | 'invocation.finished'
  | 'review.requested'
  | 'review.resolved'
  | 'wiki.changed';

/* ─────────────── Errors ─────────────── */

/**
 * 结构化错误码。Web 需要区分"配置问题需要人工介入"与"稍后重试即可",
 * 因此错误模型是契约的一部分而不是自由文本。
 */
export const STUDIO_ERROR_CODES = [
  'studio_not_configured',
  'studio_mode_required',
  'run_not_found',
  'invocation_not_found',
  'review_not_found',
  'capacity_exhausted',
  'cancelled',
  'internal',
] as const;

export type StudioErrorCode = (typeof STUDIO_ERROR_CODES)[number];

export type StudioError = {
  code: StudioErrorCode;
  message: string;
  /** 可重试性由服务端断言,客户端不用靠 message 猜。 */
  retryable: boolean;
  identity?: StudioInvocationIdentity | StudioRunIdentityRef;
};

export function isStudioErrorCode(value: unknown): value is StudioErrorCode {
  return typeof value === 'string'
    && (STUDIO_ERROR_CODES as readonly string[]).includes(value);
}

/* ─────────────── Reconnect ─────────────── */

/**
 * 重连语义:连接只是传输,不拥有 run 生命周期。客户端带上次 cursor 重连,
 * server 从权威状态补发,既不重建 host/pet graph,也不丢正在等 review 的 run。
 */
export type StudioSubscribeCommand = {
  command: 'studio.events.subscribe';
  requestId: string;
  /** 省略表示从当前位置开始;提供则从该 cursor 之后补发。 */
  afterCursor?: number;
  runId?: string;
};

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
 * 解析 cancel 命令并保留 scope 判别式。非法 scope 返回 null 而不是猜一个默认值——
 * 猜测会导致误停其他并行任务。
 */
export function parseStudioCancelCommand(value: unknown): StudioCancelCommand | null {
  const record = asRecord(value);
  if (!record || record.command !== 'studio.cancel') return null;
  const requestId = readNonEmptyString(record, 'requestId');
  const runId = readNonEmptyString(record, 'runId');
  if (!requestId || !runId) return null;

  if (record.scope === 'run') {
    return { command: 'studio.cancel', requestId, scope: 'run', runId };
  }
  if (record.scope === 'task') {
    const taskId = readNonEmptyString(record, 'taskId');
    return taskId ? { command: 'studio.cancel', requestId, scope: 'task', runId, taskId } : null;
  }
  if (record.scope === 'invocation') {
    const invocationId = readNonEmptyString(record, 'invocationId');
    return invocationId
      ? { command: 'studio.cancel', requestId, scope: 'invocation', runId, invocationId }
      : null;
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
