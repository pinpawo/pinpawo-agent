import type { LocalAgentServerMessage } from '../localAgentProtocol';
import { TUI_TEXT } from './render/text';
import type { HistoryCellMeta, TuiAction } from './state/tuiState';

export type TuiServerMessageActionResult = {
  actions: TuiAction[];
  clearInterrupt: boolean;
};

export type TuiServerMessageActionOptions = {
  now: number;
  makeHistoryCell: () => HistoryCellMeta;
};

export function buildTuiActionsFromServerMessage(
  message: LocalAgentServerMessage,
  options: TuiServerMessageActionOptions,
): TuiServerMessageActionResult {
  if (message.type === 'pong') {
    return { actions: [], clearInterrupt: false };
  }

  if (message.type === 'event') {
    return {
      clearInterrupt: shouldClearInterruptForEvent(message.event.type),
      actions: [{
        type: 'event.received',
        event: message.event,
        now: options.now,
        historyCell: options.makeHistoryCell(),
      }],
    };
  }

  if (message.type === 'interrupting') {
    return {
      clearInterrupt: false,
      actions: [{
        type: 'server.interrupting',
        requestId: message.requestId,
        statusMessage: TUI_TEXT.interrupting,
      }],
    };
  }

  if (message.type === 'interrupted') {
    return {
      clearInterrupt: true,
      actions: [{
        type: 'server.interrupted',
        requestId: message.requestId,
        historyCell: options.makeHistoryCell(),
        statusMessage: TUI_TEXT.interruptedStatus,
      }],
    };
  }

  if (message.type === 'studio_response') {
    return {
      clearInterrupt: true,
      actions: [{
        type: 'server.studio_response',
        requestId: message.requestId,
        outcome: message.outcome,
        reply: message.reply,
        reason: message.reason,
        historyCell: options.makeHistoryCell(),
        stoppedReasonCell: options.makeHistoryCell(),
        statusMessage: TUI_TEXT.statusReady,
      }],
    };
  }

  return {
    clearInterrupt: true,
    actions: [{
      type: 'server.studio_error',
      requestId: message.requestId,
      message: message.message,
      historyCell: options.makeHistoryCell(),
      statusMessage: TUI_TEXT.studioErrorRecovered,
    }],
  };
}

function shouldClearInterruptForEvent(type: string) {
  return type === 'human_review.requested'
    || type === 'message.completed'
    || type === 'error';
}
