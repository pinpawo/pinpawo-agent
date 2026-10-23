import {
  readNotice,
  renderAgentNotice,
  type AgentNotice,
  type AgentNoticeRenderers,
} from '@pinpawo/agent-session';
import { tuiLocale, type TuiLocale } from './locale';

/** Every user-facing text the TUI writes itself, in one language. */
export type TuiText = {
  /** Labels say what happens from the user's side, never runtime terms. */
  toolCallLabel: { delegate_capability: string; plan_request: string };
  outcome: { running: string; completed: string; failed: string; interrupted: string };
  /** Wraps a status after a line: "（完成）", " (done)". */
  statusSuffix: (status: string) => string;
  operationSection: { input: string; details: string; output: string; error: string };
  toolsInvolved: (tools: string) => string;
  truncated: string;
  planProgress: (current: number, total: number, active: boolean) => string;
  planMore: (count: number) => string;
  runningPlaceholder: string;
  detailsHint: string;
  turnElapsed: (elapsed: string) => string;
  resultReference: (index: number, title: string) => string;
  /** Host notices this language renders itself; the rest show their default text. */
  notices: AgentNoticeRenderers<string>;
};

const EN: TuiText = {
  toolCallLabel: { delegate_capability: 'Execute goal', plan_request: 'Define goal' },
  outcome: { running: 'running', completed: 'done', failed: 'failed', interrupted: 'interrupted' },
  statusSuffix: (status) => ` (${status})`,
  operationSection: { input: 'Input', details: 'Details', output: 'Output', error: 'Error' },
  toolsInvolved: (tools) => `Tools: ${tools}`,
  truncated: '… (truncated)',
  planProgress: (current, total, active) => `Step ${current} of ${total} · ${active ? 'in progress' : 'up next'}`,
  planMore: (count) => `… ${count} more`,
  runningPlaceholder: 'Type the next message… · Esc interrupt',
  detailsHint: 'PageUp details',
  turnElapsed: (elapsed) => `this turn ${elapsed}`,
  resultReference: (index, title) => `Result ${index} · ${title}`,
  notices: {},
};

const ZH: TuiText = {
  toolCallLabel: { delegate_capability: '执行目标', plan_request: '确定目标' },
  outcome: { running: '进行中', completed: '完成', failed: '失败', interrupted: '已中断' },
  statusSuffix: (status) => `（${status}）`,
  operationSection: { input: '输入', details: '详情', output: '输出', error: '错误' },
  toolsInvolved: (tools) => `涉及工具：${tools}`,
  truncated: '…（内容已截断）',
  planProgress: (current, total, active) => `第 ${current} 项／共 ${total} 项 · ${active ? '进行中' : '待执行'}`,
  planMore: (count) => `… 还有 ${count} 项`,
  runningPlaceholder: '输入下一条消息… · Esc 中断',
  detailsHint: 'PageUp 详情',
  turnElapsed: (elapsed) => `本轮 ${elapsed}`,
  resultReference: (index, title) => `执行结果 ${index} · ${title}`,
  notices: {
    interrupt_closed: () => '这个 review 已关闭或不存在，请等待确认面板刷新后再应答。',
    interrupt_stale: () => '这个 review 已经变化，请等待确认面板刷新后再应答。',
    interrupt_response_invalid: () => '这个 review 应答无法识别，请重新在确认面板上操作。',
    interrupt_wrong_session: () => '请回到发起该 review 的会话再操作。',
    agent_unavailable: ({ params: { cause, retryAt, detail } }) => {
      const reason = cause === 'model_authentication'
        ? '模型认证失败，请检查 API key 配置。'
        : cause === 'model_not_found'
          ? '配置的模型不存在，请检查模型名称。'
          : retryAt
            ? `模型额度将于 ${retryAt} 恢复。`
            : '模型额度已耗尽。';
      return `${detail}\n\n${reason}已终止本次运行并关闭待确认的操作，恢复后请重新发起对话。`;
    },
    interaction_busy: () => '这个 Agent 已经有一个交互客户端。',
    client_message_invalid: () => '客户端消息协议不兼容或格式无效，请升级客户端后重试。',
    client_message_unsupported: ({ params }) => `当前 Host 不支持消息类型「${params.messageType}」。`,
    history_rejected_session_switched: ({ params }) =>
      `${params.detail}\n\n已切换到新会话，原会话保留在会话列表里，可以随时恢复。`,
    history_rejected_switch_failed: ({ params }) =>
      `${params.detail}\n\n未能切换到新会话（${params.reason}），仍停留在原会话。`,
    run_in_flight: () => '请等待当前回复结束。',
    session_compaction_unsupported: () => '当前 Host 不支持手动压缩，请升级 Host 后重试。',
    review_pending_input_not_sent: () => '当前有待确认的 review，请先通过确认面板应答；这条文本没有作为新消息发送。',
    tool_authorized_for_session: ({ params }) => params.toolName
      ? `已授权当前会话中的 ${params.toolName} 操作。`
      : '已授权当前会话中的工具操作。',
  } satisfies Required<AgentNoticeRenderers<string>>,
};

const TEXT: Record<TuiLocale, TuiText> = { en: EN, zh: ZH };

export function tuiText(): TuiText {
  return TEXT[tuiLocale()];
}

/** A notice in the TUI's language; `text` is its default text from the Host. */
export function noticeText(notice: AgentNotice | null | undefined, text: string): string {
  return notice ? renderAgentNotice(notice, tuiText().notices, (fallback) => fallback) : text;
}

/** The text of a Host message that may carry a notice's `code` and `params`. */
export function hostMessageText(message: { message: string; code?: string; params?: unknown }): string {
  return noticeText(readNotice(message), message.message);
}
