import { useRef, useState } from 'react';
import { TUI_TEXT } from './render/text';
import type { TuiAction } from './state/tuiState';
import type { TuiRuntimeController } from './TuiRuntimeController';
import type { ResumeSessionSummary } from './types';

export type ResumePickerState =
  | { status: 'closed'; sessions: ResumeSessionSummary[]; selectedIndex: number }
  | { status: 'loading'; sessions: ResumeSessionSummary[]; selectedIndex: number }
  | { status: 'open'; sessions: ResumeSessionSummary[]; selectedIndex: number };

type ResumePickerControllerOptions = {
  ready: boolean;
  busy: boolean;
  appendSystemMessage: (text: string) => void;
  clearInputValue: () => void;
  dispatch: (action: TuiAction) => void;
  resetTimelineView: () => void;
  resetStudioMode: () => void;
  runtimeController: Pick<TuiRuntimeController, 'listResumeSessions' | 'resumeSession'>;
};

export function useResumePickerController(options: ResumePickerControllerOptions) {
  const [resumePicker, setResumePicker] = useState<ResumePickerState>({
    status: 'closed',
    sessions: [],
    selectedIndex: 0,
  });
  const resumeRequestIdRef = useRef(0);

  const closeResumePicker = () => {
    resumeRequestIdRef.current += 1;
    setResumePicker((current) => ({
      status: 'closed',
      sessions: current.sessions,
      selectedIndex: current.selectedIndex,
    }));
  };

  const openResumePicker = () => {
    if (!options.ready) {
      options.appendSystemMessage(TUI_TEXT.disconnectedCannotSend);
      return;
    }
    if (options.busy) {
      options.appendSystemMessage(TUI_TEXT.busyCannotSend);
      return;
    }
    options.clearInputValue();
    const requestId = resumeRequestIdRef.current + 1;
    resumeRequestIdRef.current = requestId;
    setResumePicker((current) => ({
      status: 'loading',
      sessions: current.sessions,
      selectedIndex: current.selectedIndex,
    }));
    void options.runtimeController.listResumeSessions().then((sessions) => {
      if (resumeRequestIdRef.current !== requestId) return;
      setResumePicker({
        status: 'open',
        sessions,
        selectedIndex: 0,
      });
    }).catch((err) => {
      if (resumeRequestIdRef.current !== requestId) return;
      const message = err instanceof Error ? err.message : String(err);
      setResumePicker({ status: 'closed', sessions: [], selectedIndex: 0 });
      options.appendSystemMessage(TUI_TEXT.resumeFailed(message));
    });
  };

  const resumeSelectedSession = () => {
    if (resumePicker.status !== 'open') return;
    const selected = resumePicker.sessions[resumePicker.selectedIndex];
    if (!selected) {
      closeResumePicker();
      options.appendSystemMessage(TUI_TEXT.resumeEmpty);
      return;
    }
    const requestId = resumeRequestIdRef.current + 1;
    resumeRequestIdRef.current = requestId;
    setResumePicker((current) => ({
      status: 'loading',
      sessions: current.sessions,
      selectedIndex: current.selectedIndex,
    }));
    void options.runtimeController.resumeSession(selected.id).then(({ session, history }) => {
      if (resumeRequestIdRef.current !== requestId) return;
      options.resetStudioMode();
      options.resetTimelineView();
      options.dispatch({
        type: 'session.clear',
        statusMessage: TUI_TEXT.resumeSucceeded(session.title),
      });
      options.dispatch({
        type: 'session.set_kind',
        kind: 'chat',
      });
      options.dispatch({
        type: 'session.replace_history',
        history,
      });
      options.dispatch({
        type: 'input.set',
        value: '',
      });
      setResumePicker({ status: 'closed', sessions: [], selectedIndex: 0 });
      options.appendSystemMessage(TUI_TEXT.resumeSucceeded(session.title));
    }).catch((err) => {
      if (resumeRequestIdRef.current !== requestId) return;
      const message = err instanceof Error ? err.message : String(err);
      setResumePicker({ status: 'closed', sessions: [], selectedIndex: 0 });
      options.appendSystemMessage(TUI_TEXT.resumeFailed(message));
    });
  };

  const moveResumeSelection = (direction: -1 | 1) => {
    setResumePicker((current) => ({
      ...current,
      selectedIndex: moveResumeSelectionIndex(
        current.selectedIndex,
        current.sessions.length,
        direction,
      ),
    }));
  };

  return {
    resumePicker,
    resumePickerOpen: resumePicker.status !== 'closed',
    openResumePicker,
    closeResumePicker,
    resumeSelectedSession,
    moveResumeSelection,
  };
}

export function moveResumeSelectionIndex(
  currentIndex: number,
  sessionCount: number,
  direction: -1 | 1,
) {
  return direction < 0
    ? Math.max(0, currentIndex - 1)
    : Math.min(Math.max(0, sessionCount - 1), currentIndex + 1);
}
