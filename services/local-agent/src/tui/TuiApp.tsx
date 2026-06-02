import { randomUUID } from 'node:crypto';
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput, useStdout } from 'ink';
import { config } from '../config';
import { ApprovalPanel, buildApprovalOptions } from './components/ApprovalPanel';
import { Composer } from './components/Composer';
import { MessageBlock } from './components/MessageBlock';
import { ResumePicker } from './components/ResumePicker';
import { formatTuiCommandHelp, parseTuiCommand } from './input/commandRegistry';
import { applyComposerInput, resolveTuiKeyAction } from './input/keymap';
import {
  buildActiveOperationLines,
  buildBusyStatusLine,
} from './render/eventText';
import { formatNow } from './render/terminalText';
import { TUI_TEXT } from './render/text';
import { createInitialTuiState, createSession } from './state/tuiState';
import {
  selectFocusedActiveOperations,
  selectFocusedBusy,
  selectFocusedHistory,
  selectFocusedPendingApproval,
  selectFocusedPendingUi,
  selectFocusedSession,
  selectReady,
  tuiStateReducer,
} from './state/tuiStateReducer';
import { TuiRuntimeController } from './TuiRuntimeController';
import { exportSessionTranscript } from './transcript/transcriptExport';
import type { TuiState } from './state/tuiState';
import type { MessageRole, ResumeSessionSummary } from './types';

const SPINNER_FRAMES = ['-', '\\', '|', '/'];

type ResumePickerState =
  | { status: 'closed'; sessions: ResumeSessionSummary[]; selectedIndex: number }
  | { status: 'loading'; sessions: ResumeSessionSummary[]; selectedIndex: number }
  | { status: 'open'; sessions: ResumeSessionSummary[]; selectedIndex: number };

// ---------------------------------------------------------------------------
// Main TUI application
// ---------------------------------------------------------------------------

export function TuiApp(props: { actorId: string }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const defaultSessionId = useMemo(() => `chat:${props.actorId}`, [props.actorId]);
  const [tuiState, dispatch] = useReducer(
    tuiStateReducer,
    defaultSessionId,
    (sessionId) => createInitialTuiState(createSession({ id: sessionId })),
  );
  const [animationFrame, setAnimationFrame] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [terminalSize, setTerminalSize] = useState(() => ({
    columns: stdout.columns ?? 80,
    rows: stdout.rows ?? 24,
  }));
  const [studioMode, setStudioMode] = useState(false);
  const [composerCursorOffset, setComposerCursorOffset] = useState(0);
  const [approvalIndex, setApprovalIndex] = useState(0);
  const [resumePicker, setResumePicker] = useState<ResumePickerState>({
    status: 'closed',
    sessions: [],
    selectedIndex: 0,
  });

  const stateRef = useRef<TuiState>(tuiState);
  const lastInterruptAtRef = useRef(0);
  const resumeRequestIdRef = useRef(0);
  const localServerPort = config.localServerPort;
  // Studio 模式持续期间共用一个 conversationId,这样 wiki 跨 turn 累积、
  // pet runtime 的 thread namespace 也保持一致
  const studioConversationIdRef = useRef<string | null>(null);
  const studioModeRef = useRef(false);
  const runtimeController = useMemo(() => new TuiRuntimeController({
    actorId: props.actorId,
    localServerPort,
    dispatch,
    getState: () => stateRef.current,
    setNow,
  }), [props.actorId, localServerPort, dispatch, setNow]);
  const focusedSession = selectFocusedSession(tuiState);
  const messages = selectFocusedHistory(tuiState);
  const inputValue = tuiState.input.value;
  const ready = selectReady(tuiState);
  const busy = selectFocusedBusy(tuiState);
  const pendingUi = selectFocusedPendingUi(tuiState);
  const activeOperations = selectFocusedActiveOperations(tuiState);
  const pendingApproval = selectFocusedPendingApproval(tuiState);
  const resumePickerOpen = resumePicker.status !== 'closed';
  const approvalOptions = useMemo(
    () => (pendingApproval ? buildApprovalOptions(pendingApproval) : []),
    [pendingApproval],
  );
  const petName = focusedSession?.actor.label ?? TUI_TEXT.defaultPetName;
  const petSummary = focusedSession?.actor.summary ?? TUI_TEXT.defaultPetSummary;
  const status = tuiState.connection.message;

  useEffect(() => {
    stateRef.current = tuiState;
  }, [tuiState]);

  useEffect(() => {
    setComposerCursorOffset((current) => Math.min(current, inputValue.length));
  }, [inputValue.length]);

  useEffect(() => {
    setApprovalIndex(0);
  }, [pendingApproval?.requestId]);

  useEffect(() => {
    setApprovalIndex((current) => Math.min(current, Math.max(0, approvalOptions.length - 1)));
  }, [approvalOptions.length]);

  const appendMessage = (role: MessageRole, text: string) => {
    dispatch({
      type: 'history.append',
      cell: {
        id: randomUUID(),
        kind: role,
        timestamp: formatNow(),
        text,
      },
    });
  };

  const setInputValue = (value: string) => {
    dispatch({ type: 'input.set', value });
  };

  const clearInputValue = () => {
    setInputValue('');
    setComposerCursorOffset(0);
  };

  const openResumePicker = () => {
    if (!ready) {
      appendMessage('system', TUI_TEXT.disconnectedCannotSend);
      return;
    }
    if (busy) {
      appendMessage('system', TUI_TEXT.busyCannotSend);
      return;
    }
    clearInputValue();
    const requestId = resumeRequestIdRef.current + 1;
    resumeRequestIdRef.current = requestId;
    setResumePicker((current) => ({
      status: 'loading',
      sessions: current.sessions,
      selectedIndex: current.selectedIndex,
    }));
    void runtimeController.listResumeSessions().then((sessions) => {
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
      appendMessage('system', TUI_TEXT.resumeFailed(message));
    });
  };

  const closeResumePicker = () => {
    resumeRequestIdRef.current += 1;
    setResumePicker((current) => ({
      status: 'closed',
      sessions: current.sessions,
      selectedIndex: current.selectedIndex,
    }));
  };

  const resumeSelectedSession = () => {
    if (resumePicker.status !== 'open') return;
    const selected = resumePicker.sessions[resumePicker.selectedIndex];
    if (!selected) {
      closeResumePicker();
      appendMessage('system', TUI_TEXT.resumeEmpty);
      return;
    }
    const requestId = resumeRequestIdRef.current + 1;
    resumeRequestIdRef.current = requestId;
    setResumePicker((current) => ({
      status: 'loading',
      sessions: current.sessions,
      selectedIndex: current.selectedIndex,
    }));
    void runtimeController.resumeSession(selected.id).then(({ session, history }) => {
      if (resumeRequestIdRef.current !== requestId) return;
      studioModeRef.current = false;
      studioConversationIdRef.current = null;
      setStudioMode(false);
      dispatch({
        type: 'session.clear',
        statusMessage: TUI_TEXT.resumeSucceeded(session.title),
      });
      dispatch({
        type: 'session.set_kind',
        kind: 'chat',
      });
      dispatch({
        type: 'session.replace_history',
        history,
      });
      dispatch({
        type: 'input.set',
        value: '',
      });
      setResumePicker({ status: 'closed', sessions: [], selectedIndex: 0 });
      appendMessage('system', TUI_TEXT.resumeSucceeded(session.title));
    }).catch((err) => {
      if (resumeRequestIdRef.current !== requestId) return;
      const message = err instanceof Error ? err.message : String(err);
      setResumePicker({ status: 'closed', sessions: [], selectedIndex: 0 });
      appendMessage('system', TUI_TEXT.resumeFailed(message));
    });
  };

  const submitCurrentInput = () => {
    const parsed = parseTuiCommand(inputValue);
    if (parsed.type === 'empty') return;

    if (parsed.type === 'command') {
      if (parsed.name === 'quit') {
        exit();
        return;
      }

      if (parsed.name === 'help') {
        appendMessage('system', formatTuiCommandHelp());
        clearInputValue();
        return;
      }

      if (parsed.name === 'export') {
        const session = focusedSession;
        clearInputValue();
        if (!session) {
          appendMessage('system', TUI_TEXT.exportNoSession);
          return;
        }
        void exportSessionTranscript({
          session,
          requestedPath: parsed.args || undefined,
        }).then(({ filePath }) => {
          appendMessage('system', TUI_TEXT.exportSucceeded(filePath));
        }).catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          appendMessage('system', TUI_TEXT.exportFailed(message));
        });
        return;
      }

      if (parsed.name === 'resume') {
        openResumePicker();
        return;
      }

      if (parsed.name === 'chat') {
        if (studioModeRef.current) {
          studioModeRef.current = false;
          studioConversationIdRef.current = null;
          setStudioMode(false);
          dispatch({ type: 'session.set_kind', kind: 'chat' });
          appendMessage('system', TUI_TEXT.studioExitedToChat);
        } else {
          appendMessage('system', TUI_TEXT.studioNotActive);
        }
        clearInputValue();
        return;
      }

      if (parsed.name === 'studio') {
        const userRequest = parsed.args;
        if (!userRequest && studioModeRef.current) {
          // toggle 退出
          studioModeRef.current = false;
          studioConversationIdRef.current = null;
          setStudioMode(false);
          dispatch({ type: 'session.set_kind', kind: 'chat' });
          appendMessage('system', TUI_TEXT.studioExited);
          clearInputValue();
          return;
        }
        if (!runtimeController.isConnected()) {
          appendMessage('system', TUI_TEXT.disconnectedCannotSend);
          return;
        }
        if (runtimeController.isBusy()) {
          appendMessage('system', TUI_TEXT.busyCannotSend);
          return;
        }
        // 进入 Studio 模式(若不在)
        if (!studioModeRef.current) {
          studioModeRef.current = true;
          studioConversationIdRef.current = randomUUID();
          setStudioMode(true);
          dispatch({ type: 'session.set_kind', kind: 'studio' });
          appendMessage(
            'system',
            TUI_TEXT.studioModeEntered(studioConversationIdRef.current),
          );
        }
        if (!userRequest) {
          // 仅 toggle 进入，没首条输入
          clearInputValue();
          return;
        }
        runtimeController.sendStudioRequest(userRequest, studioConversationIdRef.current);
        return;
      }

      if (parsed.name === 'new') {
        runtimeController.startNewSession();
        return;
      }

      if (parsed.name === 'allow') {
        // /allow always submits as a review decision; the server validates whether one is pending.
        runtimeController.submitReviewResponse({ label: parsed.raw, message: parsed.raw });
        return;
      }

      return;
    }

    if (parsed.type === 'unknown') {
      appendMessage('system', TUI_TEXT.unknownCommand(parsed.raw));
      clearInputValue();
      return;
    }

    const text = parsed.text;
    // Free-text input while approval panel was dismissed via Esc:
    // server still has the pending approval, so this text becomes the resume value
    // Studio 模式下:普通文本走 studio_request(沿用同一 conversationId)
    if (studioModeRef.current) {
      runtimeController.sendStudioRequest(text, studioConversationIdRef.current);
      return;
    }

    runtimeController.sendChatRequest(text);
  };

  useEffect(() => {
    if (!busy) {
      setAnimationFrame(0);
      return;
    }
    const interval = setInterval(() => {
      setAnimationFrame((current) => (current + 1) % SPINNER_FRAMES.length);
      setNow(Date.now());
    }, 120);
    return () => clearInterval(interval);
  }, [busy]);

  useEffect(() => {
    const handleResize = () => {
      setTerminalSize({
        columns: stdout.columns ?? 80,
        rows: stdout.rows ?? 24,
      });
    };
    handleResize();
    stdout.on?.('resize', handleResize);
    return () => {
      stdout.off?.('resize', handleResize);
    };
  }, [stdout]);

  useEffect(() => {
    runtimeController.start();
    return () => runtimeController.dispose();
  }, [runtimeController]);

  useInput((input, key) => {
    const action = resolveTuiKeyAction(input, key, {
      ready,
      busy,
      hasPendingApproval: Boolean(pendingApproval),
      hasResumePicker: resumePickerOpen,
    });

    switch (action.type) {
      case 'global.ctrl_c':
        if (busy) {
          const nowMs = Date.now();
          if (nowMs - lastInterruptAtRef.current < 1200) {
            appendMessage('system', TUI_TEXT.secondCtrlCExit);
            exit();
            return;
          }
          if (runtimeController.requestInterrupt()) {
            lastInterruptAtRef.current = nowMs;
          }
          appendMessage('system', TUI_TEXT.interruptRequested);
          return;
        }
        appendMessage('system', TUI_TEXT.exiting);
        exit();
        return;

      case 'global.interrupt':
        runtimeController.requestInterrupt();
        return;

      case 'approval.previous':
        setApprovalIndex((current) => Math.max(0, current - 1));
        return;

      case 'approval.next':
        setApprovalIndex((current) => Math.max(0, Math.min(approvalOptions.length - 1, current + 1)));
        return;

      case 'approval.submit': {
        const option = approvalOptions[approvalIndex] ?? approvalOptions[0];
        if (option) {
          runtimeController.submitReviewResponse(option);
        }
        return;
      }

      case 'approval.dismiss':
        if (pendingApproval) {
          runtimeController.dismissReview(pendingApproval.requestId);
        }
        return;

      case 'resume.previous':
        setResumePicker((current) => ({
          ...current,
          selectedIndex: Math.max(0, current.selectedIndex - 1),
        }));
        return;

      case 'resume.next':
        setResumePicker((current) => ({
          ...current,
          selectedIndex: Math.min(Math.max(0, current.sessions.length - 1), current.selectedIndex + 1),
        }));
        return;

      case 'resume.submit':
        resumeSelectedSession();
        return;

      case 'resume.dismiss':
        closeResumePicker();
        return;

      case 'composer.clear':
        clearInputValue();
        return;

      case 'composer.submit':
        submitCurrentInput();
        return;

      case 'composer.edit': {
        const nextComposerState = applyComposerInput(input, key, {
          value: inputValue,
          cursorOffset: composerCursorOffset,
        });
        setComposerCursorOffset(nextComposerState.cursorOffset);
        if (nextComposerState.value !== inputValue) {
          setInputValue(nextComposerState.value);
        }
        return;
      }

      case 'none':
        return;

      default:
        return;
    }
  }, { isActive: true });

  const spinnerFrame = SPINNER_FRAMES[animationFrame];
  const contentWidth = Math.max(20, terminalSize.columns - 4);
  const activeOperationLines = useMemo(
    () => buildActiveOperationLines(activeOperations, now, contentWidth),
    [activeOperations, now, contentWidth],
  );

  // Input area focus: only when ready, not busy, and no modal panel.
  const inputFocused = ready && !busy && !pendingApproval && !resumePickerOpen;

  // Contextual help text
  const helpText = busy
    ? TUI_TEXT.helpBusy
    : pendingApproval
      ? '' // help is shown inside ApprovalPanel
      : resumePickerOpen
        ? ''
        : TUI_TEXT.helpIdle;

  return (
    <Box flexDirection="column" paddingX={1}>
      {messages.length === 0 ? <Text dimColor>{TUI_TEXT.emptyHistory(petName)}</Text> : null}
      <Static items={messages}>
        {(entry) => <MessageBlock key={entry.id} entry={entry} petName={petName} width={contentWidth} />}
      </Static>
      {activeOperationLines.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {activeOperationLines.map((line) => (
            <Text key={line.id} color="blue" dimColor>
              {line.text}
            </Text>
          ))}
        </Box>
      ) : null}
      {resumePickerOpen ? (
        <ResumePicker
          sessions={resumePicker.sessions}
          selectedIndex={resumePicker.selectedIndex}
          loading={resumePicker.status === 'loading'}
          width={contentWidth}
        />
      ) : null}
      {pendingApproval ? (
        <ApprovalPanel
          approval={pendingApproval}
          width={contentWidth}
          options={approvalOptions}
          selectedIndex={approvalIndex}
        />
      ) : null}
      {!pendingApproval ? (
        <Text dimColor>
          {pendingUi
            ? buildBusyStatusLine(pendingUi, now, spinnerFrame, activeOperations)
            : `${status} · ${petSummary}`}
        </Text>
      ) : null}
      <Box
        borderStyle="round"
        borderColor={busy ? 'yellow' : pendingApproval ? 'yellow' : 'gray'}
        paddingX={1}
        marginTop={pendingApproval ? 0 : 1}
      >
        {busy ? (
          <Text dimColor>{TUI_TEXT.inputBusy}</Text>
        ) : (
          <>
            <Text color="cyan">{'> '}</Text>
            <Composer
              value={inputValue}
              cursorOffset={composerCursorOffset}
              placeholder={pendingApproval ? TUI_TEXT.approvalFreeReplyPlaceholder : TUI_TEXT.inputPlaceholder}
              focus={inputFocused}
            />
          </>
        )}
      </Box>
      {helpText ? <Text dimColor>{helpText}</Text> : null}
    </Box>
  );
}
