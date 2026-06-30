import { randomUUID } from 'node:crypto';
import { exportSessionTranscript } from '../transcript/transcriptExport';
import { formatTuiCommandHelp, parseTuiCommand } from './commandRegistry';
import { TUI_TEXT } from '../render/text';
import type { TuiAction, TuiInteractionMode } from '../state/tuiState';
import type { SessionModel } from '../state/tuiState';
import {
  formatTuiTimelineViewMode,
  parseTuiTimelineViewMode,
  type TuiTimelineViewMode,
} from '../timeline/timelineView';
import type { TuiRuntimeController } from '../TuiRuntimeController';

type TuiCommandSubmitInput = {
  inputValue: string;
  focusedSession: SessionModel | null;
  mode: TuiInteractionMode;
  studioConversationId: string | null;
  enterStudioMode: (conversationId: string) => void;
  exitStudioMode: () => void;
  openResumePicker: () => void;
  openGlobalReviewPolicyPicker: () => void;
  openExternalEditor?: (initialText: string) => void;
  exit: () => void;
  appendSystemMessage: (text: string) => void;
  clearInputValue: () => void;
  setTimelineViewMode?: (mode: TuiTimelineViewMode) => boolean;
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

    if (parsed.name === 'edit') {
      options.clearInputValue();
      if (!options.openExternalEditor) {
        options.appendSystemMessage(TUI_TEXT.externalEditorUnavailable);
        return;
      }
      options.openExternalEditor(parsed.args);
      return;
    }

    if (parsed.name === 'resume') {
      options.exitStudioMode();
      options.dispatch({ type: 'session.set_kind', kind: 'chat' });
      options.openResumePicker();
      options.clearInputValue();
      return;
    }

    if (parsed.name === 'timeline') {
      options.clearInputValue();
      const mode = parseTuiTimelineViewMode(parsed.args);
      if (!mode) {
        options.appendSystemMessage(TUI_TEXT.timelineViewUsage);
        return;
      }
      if (!options.setTimelineViewMode) {
        options.appendSystemMessage(TUI_TEXT.timelineViewUnavailable);
        return;
      }
      const switched = options.setTimelineViewMode(mode);
      options.appendSystemMessage(switched
        ? TUI_TEXT.timelineViewChanged(formatTuiTimelineViewMode(mode))
        : TUI_TEXT.timelineProcessUnavailable);
      return;
    }

    if (parsed.name === 'policy') {
      options.openGlobalReviewPolicyPicker();
      options.clearInputValue();
      return;
    }

    if (parsed.name === 'chat') {
      if (options.mode === 'studio') {
        options.exitStudioMode();
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
      if (!userRequest && options.mode === 'studio') {
        // toggle 退出
        options.exitStudioMode();
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
      let studioConversationId = options.studioConversationId;
      if (options.mode !== 'studio' || !studioConversationId) {
        studioConversationId = randomUUID();
        options.enterStudioMode(studioConversationId);
        options.dispatch({ type: 'session.set_kind', kind: 'studio' });
        options.appendSystemMessage(
          TUI_TEXT.studioModeEntered(studioConversationId),
        );
      }
      if (!userRequest) {
        // 仅 toggle 进入，没首条输入
        options.clearInputValue();
        return;
      }
      options.runtimeController.sendStudioRequest(userRequest, studioConversationId);
      return;
    }

    if (parsed.name === 'new') {
      options.exitStudioMode();
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
  // Free text is never a human-review resume. Review responses are sent only
  // through the approval panel's canonical human_review_response message.
  // Studio 模式下:普通文本走 studio_request(沿用同一 conversationId)
  if (options.mode === 'studio') {
    const studioConversationId = options.studioConversationId ?? randomUUID();
    if (!options.studioConversationId) {
      options.enterStudioMode(studioConversationId);
    }
    options.runtimeController.sendStudioRequest(text, studioConversationId);
    return;
  }

  options.runtimeController.sendChatRequest(text);
}
