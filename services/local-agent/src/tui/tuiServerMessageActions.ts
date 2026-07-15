import type { LocalAgentRuntimeEvent } from '../events/localAgentRuntimeEvent';
import type { LocalAgentSessionMessageInput } from '../localAgentSession';
import type { LocalAgentServerMessage } from '../localAgentProtocol';
import {
  formatStudioProgressEvent,
  formatSystemNoticeEvent,
} from './render/eventText';
import { TUI_TEXT } from './render/text';
import type { TuiAction } from './state/tuiState';

export type TuiServerMessageActionResult = {
  actions: TuiAction[];
  clearInterrupt: boolean;
};

export type TuiServerMessageActionOptions = {
  now: number;
  createMessage: (
    input: Omit<LocalAgentSessionMessageInput, 'createdAt'>,
  ) => LocalAgentSessionMessageInput;
};

export function buildTuiActionsFromServerMessage(
  message: LocalAgentServerMessage,
  options: TuiServerMessageActionOptions,
): TuiServerMessageActionResult {
  if (message.type === 'pong') {
    return { actions: [], clearInterrupt: false };
  }

  if (message.type === 'event') {
    const normalizedMessage = runtimeEventMessage(message.event, options.createMessage);
    return {
      clearInterrupt: shouldClearInterruptForEvent(message.event.type),
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
      clearInterrupt: false,
      actions: [{
        type: 'run.interrupting',
        requestId: message.requestId,
      }],
    };
  }

  if (message.type === 'interrupted') {
    return {
      clearInterrupt: true,
      actions: [{
        type: 'run.finish',
        requestId: message.requestId,
        messages: [options.createMessage({
          role: 'assistant',
          text: TUI_TEXT.interrupted,
          requestId: message.requestId,
          source: 'live-event',
        })],
        statusNotice: TUI_TEXT.interruptedStatus,
      }],
    };
  }

  if (message.type === 'studio_response') {
    const reply = message.reply.trim();
    const messages = [options.createMessage({
      role: reply ? 'assistant' : 'system',
      text: reply || TUI_TEXT.studioEmptyTurn(message.outcome),
      requestId: message.requestId,
      source: 'live-event',
    })];
    if (message.outcome === 'stopped' && message.reason) {
      messages.push(options.createMessage({
        role: 'system',
        text: TUI_TEXT.studioStoppedReason(message.reason),
        requestId: message.requestId,
        source: 'live-event',
      }));
    }
    return {
      clearInterrupt: true,
      actions: [{
        type: 'run.finish',
        requestId: message.requestId,
        messages,
      }],
    };
  }

  return {
    clearInterrupt: true,
    actions: [{
      type: 'run.finish',
      requestId: message.requestId,
      messages: [options.createMessage({
        role: 'system',
        text: TUI_TEXT.studioErrorLine(message.message || 'studio error'),
        requestId: message.requestId,
        source: 'live-event',
      })],
      statusNotice: TUI_TEXT.studioErrorRecovered,
    }],
  };
}

function runtimeEventMessage(
  event: LocalAgentRuntimeEvent,
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
            source: 'live-event',
          })
        : undefined;
    }
    case 'studio.progress': {
      const text = formatStudioProgressEvent(event);
      return text
        ? createMessage({
            role: 'system',
            requestId: event.requestId,
            text,
            source: 'live-event',
          })
        : undefined;
    }
    case 'error':
      return createMessage({
        role: 'system',
        requestId: event.requestId,
        text: TUI_TEXT.errorLine(event.message || 'internal error'),
        source: 'live-event',
      });
    default:
      return undefined;
  }
}

function shouldClearInterruptForEvent(type: string) {
  return type === 'human_review.requested'
    || type === 'message.completed'
    || type === 'error';
}
