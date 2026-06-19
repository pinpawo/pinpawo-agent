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
  serverMode: 'chat' | 'studio';
  studioConversationIdRef: { current: string | null };
  openResumePicker: () => void;
  openExternalEditor?: (initialText: string) => void;
  exit: () => void;
  appendSystemMessage: (text: string) => void;
  clearInputValue: () => void;
  dispatch: (action: TuiAction) => void;
  runtimeController: Pick<TuiRuntimeController, 'isConnected' | 'isBusy' | 'sendStudioRequest' | 'sendChatRequest' | 'startNewSession' | 'submitReviewResponse'>;
};

function ensureStudioConversationId(ref: { current: string | null }): string {
  ref.current ??= randomUUID();
  return ref.current;
}

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
      options.openResumePicker();
      return;
    }

    if (parsed.name === 'new') {
      if (options.serverMode === 'studio') {
        options.studioConversationIdRef.current = randomUUID();
        options.dispatch({ type: 'session.set_kind', kind: 'studio' });
      }
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
  if (options.serverMode === 'studio') {
    options.runtimeController.sendStudioRequest(text, ensureStudioConversationId(options.studioConversationIdRef));
    return;
  }

  options.runtimeController.sendChatRequest(text);
}
