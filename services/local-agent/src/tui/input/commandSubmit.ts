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
  openResumePicker: () => void;
  openModelProfilePicker: () => void;
  openGlobalReviewPolicyPicker: () => void;
  openTranscriptViewer: () => void;
  openExternalEditor?: (initialText: string) => void;
  exit: () => void;
  appendSystemMessage: (text: string) => void;
  clearInputValue: () => void;
  dispatch: (action: TuiAction) => void;
  runtimeController: Pick<
    TuiRuntimeController,
    | 'isConnected'
    | 'isBusy'
    | 'continueActiveDelegation'
    | 'sendChatRequest'
    | 'startNewSession'
    | 'submitReviewResponse'
  >;
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

    if (parsed.name === 'transcript') {
      options.clearInputValue();
      options.openTranscriptViewer();
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
      options.dispatch({
        type: 'session.configured',
        kind: 'chat',
      });
      options.openResumePicker();
      options.clearInputValue();
      return;
    }

    if (parsed.name === 'model') {
      options.dispatch({
        type: 'session.configured',
        kind: 'chat',
      });
      options.openModelProfilePicker();
      options.clearInputValue();
      return;
    }

    if (parsed.name === 'continue') {
      if (!parsed.args) {
        options.appendSystemMessage(TUI_TEXT.continueRequiresGuidance);
        options.clearInputValue();
        return;
      }
      options.dispatch({
        type: 'session.configured',
        kind: 'chat',
      });
      options.runtimeController.continueActiveDelegation(parsed.args);
      return;
    }

    if (parsed.name === 'policy') {
      options.openGlobalReviewPolicyPicker();
      options.clearInputValue();
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
  // Free text is never a human-review resume. Review responses are sent only
  // through the approval panel's canonical human_review_response message.
  options.runtimeController.sendChatRequest(text);
}
