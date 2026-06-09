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
import { applyComposerInput, resolveTuiKeyAction } from './input/keymap';
import { submitCurrentInputFromController } from './input/commandSubmit';
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
import { useResumePickerController } from './useResumePickerController';
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
  const [composerCursorOffset, setComposerCursorOffset] = useState(0);
  const [approvalIndex, setApprovalIndex] = useState(0);

  const stateRef = useRef<TuiState>(tuiState);
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
  const inputValue = tuiState.input.value;
  const ready = selectReady(tuiState);
  const busy = selectFocusedBusy(tuiState);
  const pendingUi = selectFocusedPendingUi(tuiState);
  const activeOperations = selectFocusedActiveOperations(tuiState);
  const pendingApproval = selectFocusedPendingApproval(tuiState);
  const reviewOptions = pendingApproval?.review.options ?? [];
  const petName = focusedSession?.actor.label ?? TUI_TEXT.defaultPetName;
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

  const setInputValue = (value: string) => {
    dispatch({ type: 'input.set', value });
  };

  const clearInputValue = () => {
    setInputValue('');
    setComposerCursorOffset(0);
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
      clearInputValue,
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
        setApprovalIndex((current) => Math.max(0, Math.min(reviewOptions.length - 1, current + 1)));
        return;

      case 'approval.submit': {
        const textInputOption = inputValue.trim()
          ? reviewOptions.find((option) => option.input?.kind === 'text') ?? null
          : null;
        const option = textInputOption ?? reviewOptions[approvalIndex] ?? reviewOptions[0];
        if (option) {
          runtimeController.submitReviewResponse(option, inputValue);
        }
        return;
      }

      case 'approval.dismiss':
        if (pendingApproval) {
          runtimeController.dismissReview(pendingApproval.requestId);
        }
        return;

      case 'resume.previous':
        moveResumeSelection(-1);
        return;

      case 'resume.next':
        moveResumeSelection(1);
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
  const inputFocused = ready && !busy && !resumePickerOpen;

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
