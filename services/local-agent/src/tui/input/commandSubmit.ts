import { randomUUID } from 'node:crypto';
import { exportSessionTranscript } from '../transcript/transcriptExport';
import { formatTuiCommandHelp, parseTuiCommand } from './commandRegistry';
import { TUI_TEXT } from '../render/text';
import type { TuiAction } from '../state/tuiState';
import type { SessionModel } from '../state/tuiState';
import type { TuiRuntimeController } from '../TuiRuntimeController';

type TuiCommandSubmitInput = {
  inputValue: string;
  focusedSession: SessionModel | null;
  studioModeRef: { current: boolean };
  studioConversationIdRef: { current: string | null };
  setStudioMode: (value: boolean) => void;
  openResumePicker: () => void;
  exit: () => void;
  appendSystemMessage: (text: string) => void;
  clearInputValue: () => void;
  dispatch: (action: TuiAction) => void;
  runtimeController: Pick<TuiRuntimeController, 'isConnected' | 'isBusy' | 'sendStudioRequest' | 'sendChatRequest' | 'startNewSession' | 'submitReviewResponse'>;
};

export function submitCurrentInputFromController(options: TuiCommandSubmitInput) {
  const parsed = parseTuiCommand(options.inputValue);
  if (parsed.type === 'empty') return;

  if (parsed.type === 'command') {
    if (parsed.name === 'quit') {
      options.exit();
      return;
    }

    if (parsed.name === 'help') {
      options.appendSystemMessage(formatTuiCommandHelp());
      options.clearInputValue();
      return;
    }

    if (parsed.name === 'export') {
      const session = options.focusedSession;
      options.clearInputValue();
      if (!session) {
        options.appendSystemMessage(TUI_TEXT.exportNoSession);
        return;
      }
      void exportSessionTranscript({
        session,
        requestedPath: parsed.args || undefined,
      }).then(({ filePath }) => {
        options.appendSystemMessage(TUI_TEXT.exportSucceeded(filePath));
      }).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        options.appendSystemMessage(TUI_TEXT.exportFailed(message));
      });
      return;
    }

    if (parsed.name === 'resume') {
      options.openResumePicker();
      return;
    }

    if (parsed.name === 'chat') {
      if (options.studioModeRef.current) {
        options.studioModeRef.current = false;
        options.studioConversationIdRef.current = null;
        options.setStudioMode(false);
        options.dispatch({ type: 'session.set_kind', kind: 'chat' });
        options.appendSystemMessage(TUI_TEXT.studioExitedToChat);
      } else {
        options.appendSystemMessage(TUI_TEXT.studioNotActive);
      }
      options.clearInputValue();
      return;
    }

    if (parsed.name === 'studio') {
      const userRequest = parsed.args;
      if (!userRequest && options.studioModeRef.current) {
        // toggle 退出
        options.studioModeRef.current = false;
        options.studioConversationIdRef.current = null;
        options.setStudioMode(false);
        options.dispatch({ type: 'session.set_kind', kind: 'chat' });
        options.appendSystemMessage(TUI_TEXT.studioExited);
        options.clearInputValue();
        return;
      }
      if (!options.runtimeController.isConnected()) {
        options.appendSystemMessage(TUI_TEXT.disconnectedCannotSend);
        return;
      }
      if (options.runtimeController.isBusy()) {
        options.appendSystemMessage(TUI_TEXT.busyCannotSend);
        return;
      }
      // 进入 Studio 模式(若不在)
      if (!options.studioModeRef.current) {
        options.studioModeRef.current = true;
        options.studioConversationIdRef.current = randomUUID();
        options.setStudioMode(true);
        options.dispatch({ type: 'session.set_kind', kind: 'studio' });
        options.appendSystemMessage(
          TUI_TEXT.studioModeEntered(options.studioConversationIdRef.current),
        );
      }
      if (!userRequest) {
        // 仅 toggle 进入，没首条输入
        options.clearInputValue();
        return;
      }
      options.runtimeController.sendStudioRequest(userRequest, options.studioConversationIdRef.current);
      return;
    }

    if (parsed.name === 'new') {
      options.runtimeController.startNewSession();
      return;
    }

    return;
  }

  if (parsed.type === 'unknown') {
    options.appendSystemMessage(TUI_TEXT.unknownCommand(parsed.raw));
    options.clearInputValue();
    return;
  }

  const text = parsed.text;
  // Free-text input while approval panel was dismissed via Esc:
  // server still has the pending approval, so this text becomes the resume value
  // Studio 模式下:普通文本走 studio_request(沿用同一 conversationId)
  if (options.studioModeRef.current) {
    options.runtimeController.sendStudioRequest(text, options.studioConversationIdRef.current);
    return;
  }

  options.runtimeController.sendChatRequest(text);
}
