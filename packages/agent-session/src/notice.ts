import { assertNever, hasOnlyKeys, isJsonObject } from '@pinpawo/agent-contracts';
import type { AgentErrorEvent, AgentSystemNoticeEvent } from './events';

/**
 * Why the agent's model cannot run at all. `model_quota` covers an exhausted
 * quota or rate limit; the provider's reset time travels as `retryAt`.
 */
export type AgentUnavailableCause =
  | 'model_authentication'
  | 'model_not_found'
  | 'model_quota';

/**
 * A user-facing notice the Host sends as data. The Host never localizes: it
 * sends `code` and `params`, with the English default text as the event's
 * `message`. Each client renders the codes it knows in its own language and
 * shows the default text for the rest, so the Host needs no locale.
 *
 * `detail` params carry text the Host did not write (a provider's error
 * message) and are shown as they are.
 */
export type AgentNotice =
  // The review the client answered is closed or does not exist.
  | { code: 'interrupt_closed' }
  // The review changed after the client rendered it.
  | { code: 'interrupt_stale' }
  // The review answer could not be read.
  | { code: 'interrupt_response_invalid' }
  // The review belongs to another session than the one answering it.
  | { code: 'interrupt_wrong_session' }
  // The agent could not run at all (model quota exhausted, auth rejected).
  // The invocation terminates; checkpoint state remains authoritative for any
  // pending interrupt and is reconciled separately.
  | { code: 'agent_unavailable'; params: { cause: AgentUnavailableCause; retryAt?: string; detail: string } }
  // A second interactive client tried to attach. One Host serves one Pet and
  // its session state is single-valued, so interaction is exclusive;
  // additional input belongs in dispatch, which queues behind the gate.
  | { code: 'interaction_busy' }
  // The client sent a message this Host cannot read.
  | { code: 'client_message_invalid' }
  | { code: 'client_message_unsupported'; params: { messageType: string } }
  // The model provider rejected the session history; the Host switched to a
  // new session or failed to. The old session is kept either way.
  | { code: 'history_rejected_session_switched'; params: { detail: string } }
  | { code: 'history_rejected_switch_failed'; params: { detail: string; reason: string } }
  // The command waits for the current response to finish.
  | { code: 'run_in_flight' }
  | { code: 'session_compaction_unsupported' }
  // Text sent while a review is pending is not delivered as a new message.
  | { code: 'review_pending_input_not_sent' }
  | { code: 'tool_authorized_for_session'; params: { toolName?: string } };

export type AgentNoticeCode = AgentNotice['code'];

/** Codes an `error` event may carry. */
export type AgentErrorCode = Extract<AgentNoticeCode,
  | 'interrupt_closed'
  | 'interrupt_stale'
  | 'interrupt_response_invalid'
  | 'interrupt_wrong_session'
  | 'agent_unavailable'
  | 'interaction_busy'
  | 'client_message_invalid'
  | 'client_message_unsupported'
  | 'history_rejected_session_switched'
  | 'history_rejected_switch_failed'
  | 'run_in_flight'
  | 'session_compaction_unsupported'>;

/** Codes a `system.notice` event may carry. */
export type AgentSystemNoticeCode = Exclude<AgentNoticeCode, AgentErrorCode>;

export type AgentErrorNotice = Extract<AgentNotice, { code: AgentErrorCode }>;

/**
 * A message's notice fields: none, or one notice's `code` and `params`. The
 * message's `message` is always present as the notice's default text.
 */
export type AgentNoticeFields<TCode extends AgentNoticeCode> =
  | { code?: undefined; params?: undefined }
  | Extract<AgentNotice, { code: TCode }>;
export type AgentSystemNotice = Extract<AgentNotice, { code: AgentSystemNoticeCode }>;

const ERROR_CODES: ReadonlySet<string> = new Set<AgentErrorCode>([
  'interrupt_closed',
  'interrupt_stale',
  'interrupt_response_invalid',
  'interrupt_wrong_session',
  'agent_unavailable',
  'interaction_busy',
  'client_message_invalid',
  'client_message_unsupported',
  'history_rejected_session_switched',
  'history_rejected_switch_failed',
  'run_in_flight',
  'session_compaction_unsupported',
]);

export function isAgentErrorNotice(notice: AgentNotice): notice is AgentErrorNotice {
  return ERROR_CODES.has(notice.code);
}

/**
 * The English default text of a notice: the Host sends it as `message`, and
 * clients fall back to it for codes they do not render. The switch is
 * exhaustive, so adding a code without its text fails typecheck.
 */
export function agentNoticeToText(notice: AgentNotice): string {
  switch (notice.code) {
    case 'interrupt_closed':
      return 'This review is closed or no longer exists. Wait for the review panel to refresh before answering.';
    case 'interrupt_stale':
      return 'This review has changed. Wait for the review panel to refresh before answering.';
    case 'interrupt_response_invalid':
      return 'This review answer could not be read. Answer again in the review panel.';
    case 'interrupt_wrong_session':
      return 'Go back to the session that started this review to answer it.';
    case 'agent_unavailable': {
      const { cause, retryAt, detail } = notice.params;
      const reason = cause === 'model_authentication'
        ? 'Model authentication failed; check the API key.'
        : cause === 'model_not_found'
          ? 'The configured model does not exist; check the model name.'
          : retryAt
            ? `The model quota resets at ${retryAt}.`
            : 'The model quota is exhausted.';
      return `${detail}\n\n${reason} This run was stopped and any pending review was closed. Start the conversation again once it is resolved.`;
    }
    case 'interaction_busy':
      return 'This Agent already has an interactive client.';
    case 'client_message_invalid':
      return 'The client message is invalid or incompatible with this Host. Upgrade the client and try again.';
    case 'client_message_unsupported':
      return `Message type "${notice.params.messageType}" is not supported by this Host transport.`;
    case 'history_rejected_session_switched':
      return `${notice.params.detail}\n\nSwitched to a new session. The previous session is kept in the session list and can be resumed at any time.`;
    case 'history_rejected_switch_failed':
      return `${notice.params.detail}\n\nCould not switch to a new session (${notice.params.reason}); still in the current session.`;
    case 'run_in_flight':
      return 'Wait for the current response to finish.';
    case 'session_compaction_unsupported':
      return 'This Host does not support manual compaction. Upgrade the Host and try again.';
    case 'review_pending_input_not_sent':
      return 'A review is waiting for your answer. Answer it in the review panel first; this text was not sent as a new message.';
    case 'tool_authorized_for_session':
      return notice.params.toolName
        ? `Authorized ${notice.params.toolName} for this session.`
        : 'Authorized tool use for this session.';
    default:
      return assertNever(notice);
  }
}

/**
 * A client's native renderers: one per code it chooses to render itself.
 * Every entry is optional; a code without one is shown as its default text.
 */
export type AgentNoticeRenderers<R> = {
  [K in AgentNoticeCode]?: (notice: Extract<AgentNotice, { code: K }>) => R;
};

/**
 * The one dispatch every client uses: the client's renderer when it has one,
 * otherwise `fallback` with the default text.
 */
export function renderAgentNotice<R>(
  notice: AgentNotice,
  renderers: AgentNoticeRenderers<R>,
  fallback: (text: string, notice: AgentNotice) => R,
): R {
  const render = renderers[notice.code] as ((known: AgentNotice) => R) | undefined;
  return render ? render(notice) : fallback(agentNoticeToText(notice), notice);
}

/**
 * Reads `code` and `params` from a received record. A code this version does
 * not know, or params that do not match it, yield `null`: the receiver then
 * shows the record's default text, which a newer Host always sends.
 */
export function parseAgentNotice(record: Record<string, unknown>): AgentNotice | null {
  const code = record.code;
  const params = record.params;
  if (typeof code !== 'string') return null;
  const notice = { code, ...(params === undefined ? {} : { params }) } as AgentNotice;
  switch (notice.code) {
    case 'interrupt_closed':
    case 'interrupt_stale':
    case 'interrupt_response_invalid':
    case 'interrupt_wrong_session':
    case 'interaction_busy':
    case 'client_message_invalid':
    case 'run_in_flight':
    case 'session_compaction_unsupported':
    case 'review_pending_input_not_sent':
      return params === undefined ? { code: notice.code } : null;
    case 'agent_unavailable':
      return readParams(params, ['cause', 'detail'], ['retryAt'])
        && isAgentUnavailableCause((params as Record<string, unknown>).cause)
        ? notice
        : null;
    case 'client_message_unsupported':
      return readParams(params, ['messageType']) ? notice : null;
    case 'history_rejected_session_switched':
      return readParams(params, ['detail']) ? notice : null;
    case 'history_rejected_switch_failed':
      return readParams(params, ['detail', 'reason']) ? notice : null;
    case 'tool_authorized_for_session':
      return readParams(params, [], ['toolName']) ? notice : null;
    default:
      return null;
  }
}

function readParams(
  params: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): params is Record<string, string> {
  return isJsonObject(params)
    && hasOnlyKeys(params, [...required, ...optional])
    && required.every((key) => typeof params[key] === 'string')
    && optional.every((key) => params[key] === undefined || typeof params[key] === 'string');
}

function isAgentUnavailableCause(value: unknown): value is AgentUnavailableCause {
  return value === 'model_authentication' || value === 'model_not_found' || value === 'model_quota';
}

export function cloneAgentNotice(notice: AgentNotice): AgentNotice {
  return 'params' in notice ? { ...notice, params: { ...notice.params } } as AgentNotice : { ...notice };
}

/** A message's notice fields with the notice's default text as `message`. */
export function agentNoticeMessage(notice: AgentErrorNotice): { message: string } & AgentErrorNotice {
  return { message: agentNoticeToText(notice), ...notice };
}

/** An `error` event carrying `notice`, with its default text as `message`. */
export function agentErrorEvent(
  requestId: string,
  notice: AgentErrorNotice,
  extra: Pick<AgentErrorEvent, 'diagnostics'> = {},
): AgentErrorEvent {
  return { type: 'error', requestId, message: agentNoticeToText(notice), ...extra, ...notice };
}

/** A `system.notice` event carrying `notice`, with its default text as `message`. */
export function agentSystemNoticeEvent(
  requestId: string,
  notice: AgentSystemNotice,
): AgentSystemNoticeEvent {
  return { type: 'system.notice', requestId, message: agentNoticeToText(notice), ...notice };
}

/** The notice a message carries, if any. */
export function readNotice(message: { code?: string; params?: unknown }): AgentNotice | null {
  if (message.code === undefined) return null;
  const { code, params } = message;
  return params === undefined ? { code } as AgentNotice : { code, params } as AgentNotice;
}
