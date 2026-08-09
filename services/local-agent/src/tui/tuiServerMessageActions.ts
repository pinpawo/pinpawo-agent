import type { AgentRuntimeEvent } from '@pinpawo/agent-session';
import type { AgentSessionMessageInput } from '@pinpawo/agent-session';
import type { LocalAgentServerMessage } from '../localAgentProtocol';
import {
  formatSystemNoticeEvent,
} from './render/eventText';
import { TUI_TEXT } from './render/text';
import type { TuiAction } from './state/tuiState';

export type TuiServerMessageActionResult = {
  actions: TuiAction[];
};

export type TuiServerMessageActionOptions = {
  now: number;
  createMessage: (
    input: Omit<AgentSessionMessageInput, 'createdAt'>,
  ) => AgentSessionMessageInput;
};

export function buildTuiActionsFromServerMessage(
  message: LocalAgentServerMessage,
  options: TuiServerMessageActionOptions,
): TuiServerMessageActionResult {
  if (message.type === 'pong') {
    return { actions: [] };
  }

  if (
    message.type === 'session.snapshot.result'
    || message.type === 'session.list.result'
    || message.type === 'session.new.result'
    || message.type === 'session.resume.result'
    || message.type === 'session.error'
    || message.type === 'runtime_config.result'
    || message.type === 'runtime_config.error'
    || message.type === 'model.list.result'
    || message.type === 'model.select.result'
    || message.type === 'model.select.error'
  ) {
    // Request/response clients own correlation; session results are not live
    // run events and must never enter the timeline reducer.
    return { actions: [] };
  }

  if (message.type === 'event') {
    const normalizedMessage = runtimeEventMessage(message.event, options.createMessage);
    return {
      actions: [{
        type: 'event.received',
        event: message.event,
        now: options.now,
        ...(normalizedMessage ? { message: normalizedMessage } : {}),
      }],
    };
  }

  if (message.type === 'interrupting') {
    return {
      actions: [{
        type: 'run.interrupting',
        requestId: message.requestId,
      }],
    };
  }

  if (message.type === 'interrupted') {
    return {
      actions: [{
        type: 'run.finish',
        requestId: message.requestId,
        messages: [options.createMessage({
          role: 'assistant',
          text: TUI_TEXT.interrupted,
          requestId: message.requestId,
        })],
        statusNotice: TUI_TEXT.interruptedStatus,
      }],
    };
  }

  // 旧 Ink TUI 不再发起 Studio run(#561),因此这些回包不可达;
  // 保留分支只为让类型收敛,不进时间线。
  return { actions: [] };
}

function runtimeEventMessage(
  event: AgentRuntimeEvent,
  createMessage: TuiServerMessageActionOptions['createMessage'],
) {
  switch (event.type) {
    case 'system.notice': {
      const text = formatSystemNoticeEvent(event);
      return text
        ? createMessage({
            role: 'system',
            requestId: event.requestId,
            text,
          })
        : undefined;
    }
    case 'error':
      return createMessage({
        role: 'system',
        requestId: event.requestId,
        text: TUI_TEXT.errorLine(event.message || 'internal error'),
      });
    default:
      return undefined;
  }
}
