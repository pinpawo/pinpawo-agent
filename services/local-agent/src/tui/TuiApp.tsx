import { randomUUID } from 'node:crypto';
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput, useStdout } from 'ink';
import { config } from '../config';
import { ApprovalPanel } from './components/ApprovalPanel';
import { Composer } from './components/Composer';
import { MessageBlock } from './components/MessageBlock';
import { RuntimeInfoLine } from './components/RuntimeInfoLine';
import { TokenUsageLine } from './components/TokenUsageLine';
import { ResumePicker } from './components/ResumePicker';
import {
  createInitialTuiInputBufferState,
  normalizeTuiInputEvent,
  toCanonicalInputEvent,
} from './input/keymap';
import { resolveTuiInputAction } from './input/inputRouter';
import { submitCurrentInputFromController } from './input/commandSubmit';
import {
  buildActiveOperationLines,
  buildBusyStatusLine,
  formatSubagentMessage,
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
  selectFocusedSubagentDraft,
  selectReady,
  tuiStateReducer,
} from './state/tuiStateReducer';
import { TuiRuntimeController } from './TuiRuntimeController';
import { useResumePickerController } from './useResumePickerController';
import { useTextAreaController } from './useTextAreaController';
import type { TuiState } from './state/tuiState';
import type { MessageRole } from './types';

const SPINNER_FRAMES = ['-', '\\', '|', '/'];

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
  const [approvalIndex, setApprovalIndex] = useState(0);

  const stateRef = useRef<TuiState>(tuiState);
  const inputBufferRef = useRef(createInitialTuiInputBufferState());
  const lastInterruptAtRef = useRef(0);
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
  const ready = selectReady(tuiState);
  const busy = selectFocusedBusy(tuiState);
  const pendingUi = selectFocusedPendingUi(tuiState);
  const activeOperations = selectFocusedActiveOperations(tuiState);
  const subagentDraft = selectFocusedSubagentDraft(tuiState);
  const subagentMessage = formatSubagentMessage(subagentDraft);
  const pendingApproval = selectFocusedPendingApproval(tuiState);
  const reviewOptions = pendingApproval?.review.options ?? [];
  const petName = focusedSession?.actor.label ?? TUI_TEXT.defaultPetName;
  const status = tuiState.connection.message;
  const contentWidth = Math.max(20, terminalSize.columns - 4);
  const textAreaWidth = Math.max(8, contentWidth - 4);

  useEffect(() => {
    stateRef.current = tuiState;
  }, [tuiState]);

  useEffect(() => {
    setApprovalIndex(0);
  }, [pendingApproval?.requestId]);

  useEffect(() => {
    setApprovalIndex((current) => Math.min(current, Math.max(0, reviewOptions.length - 1)));
  }, [reviewOptions.length]);

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

  const clearInputValue = () => {
    dispatch({ type: 'input.set', value: '', cursorOffset: 0 });
  };

  const resetStudioMode = () => {
    studioModeRef.current = false;
    studioConversationIdRef.current = null;
    setStudioMode(false);
  };

  const {
    resumePicker,
    resumePickerOpen,
    openResumePicker,
    closeResumePicker,
    resumeSelectedSession,
    moveResumeSelection,
  } = useResumePickerController({
    ready,
    busy,
    appendSystemMessage: (text) => appendMessage('system', text),
    clearInputValue,
    dispatch,
    resetStudioMode,
    runtimeController,
  });

  // Input area focus: only when ready, not busy, and no modal panel.
  const inputFocused = ready && !busy && !resumePickerOpen;
  const textArea = useTextAreaController({
    input: tuiState.input,
    focused: inputFocused,
    placeholder: pendingApproval ? TUI_TEXT.approvalFreeReplyPlaceholder : TUI_TEXT.inputPlaceholder,
    width: textAreaWidth,
    dispatch,
  });
  const inputValue = textArea.value;

  const submitCurrentInput = () => {
    submitCurrentInputFromController({
      inputValue,
      focusedSession,
      studioModeRef,
      studioConversationIdRef,
      setStudioMode,
      openResumePicker,
      exit,
      appendSystemMessage: (text) => appendMessage('system', text),
      clearInputValue: textArea.clear,
      dispatch,
      runtimeController,
    });
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
    const normalized = normalizeTuiInputEvent(input, key, inputBufferRef.current);
    inputBufferRef.current = normalized.state;
    if (!normalized.event) {
      return;
    }
    const inputEvent = toCanonicalInputEvent(normalized.event);
    const action = resolveTuiInputAction(inputEvent, {
      ready,
      busy,
      hasPendingApproval: Boolean(pendingApproval),
      hasResumePicker: resumePickerOpen,
    });

    switch (action.target) {
      case 'global':
        if (action.action === 'ctrl_c') {
          if (busy || pendingApproval) {
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
        }
        runtimeController.requestInterrupt();
        return;

      case 'approval':
        if (action.action === 'previous') {
          setApprovalIndex((current) => Math.max(0, current - 1));
          return;
        }
        if (action.action === 'next') {
          setApprovalIndex((current) => Math.max(0, Math.min(reviewOptions.length - 1, current + 1)));
          return;
        }
        {
          const textInputOption = inputValue.trim()
            ? reviewOptions.find((option) => option.input?.kind === 'text') ?? null
            : null;
          const option = textInputOption ?? reviewOptions[approvalIndex] ?? reviewOptions[0];
          if (option) {
            runtimeController.submitReviewResponse(option, inputValue);
          }
          return;
        }

      case 'resume':
        if (action.action === 'previous') {
          moveResumeSelection(-1);
          return;
        }
        if (action.action === 'next') {
          moveResumeSelection(1);
          return;
        }
        if (action.action === 'submit') {
          resumeSelectedSession();
          return;
        }
        closeResumePicker();
        return;

      case 'composer':
        if (action.action === 'clear') {
          textArea.clear();
          return;
        }
        if (action.action === 'submit') {
          submitCurrentInput();
          return;
        }
        return;

      case 'textarea':
        textArea.applyCommand(action.command);
        return;

      case 'none':
        return;
    }
  }, { isActive: true });

  const spinnerFrame = SPINNER_FRAMES[animationFrame];
  const activeOperationLines = useMemo(
    () => buildActiveOperationLines(activeOperations, now, contentWidth),
    [activeOperations, now, contentWidth],
  );

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
      {subagentMessage ? (
        <MessageBlock
          entry={{ kind: 'system', text: subagentMessage }}
          petName={petName}
          width={contentWidth}
        />
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
          review={pendingApproval.review}
          petId={pendingApproval.petId}
          width={contentWidth}
          selectedIndex={approvalIndex}
        />
      ) : null}
      {!pendingApproval ? (
        <>
          <Text dimColor>
            {pendingUi
              ? buildBusyStatusLine(pendingUi, now, spinnerFrame, activeOperations)
              : status}
          </Text>
          {focusedSession ? <RuntimeInfoLine runtime={focusedSession.runtime} /> : null}
          {focusedSession?.tokenUsage ? <TokenUsageLine tokenUsage={focusedSession.tokenUsage} /> : null}
        </>
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
              {...textArea.composerProps}
            />
          </>
        )}
      </Box>
      {helpText ? <Text dimColor>{helpText}</Text> : null}
    </Box>
  );
}
