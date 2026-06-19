import { randomUUID } from 'node:crypto';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput, useStdout } from 'ink';
import type { BuiltinGlobalReviewPolicyMode } from '@pinpawo/pet-agent';
import { config } from '../config';
import { loadStoredConfig, saveStoredConfig } from '../storage';
import { AgentTimeline } from './components/AgentTimeline';
import { AgentTimelineItem } from './components/AgentTimelineItem';
import { ApprovalPanel } from './components/ApprovalPanel';
import { BottomStatusLine } from './components/BottomStatusLine';
import { CommandPalette } from './components/CommandPalette';
import { Composer } from './components/Composer';
import { FileMentionPopup } from './components/FileMentionPopup';
import { GlobalReviewPolicyPicker } from './components/GlobalReviewPolicyPicker';
import { ResumePicker } from './components/ResumePicker';
import {
  createInitialTuiInputBufferState,
  normalizeTuiInputEvent,
  toCanonicalInputEvent,
} from './input/keymap';
import { getComposerHistoryAvailability } from './input/composerHistory';
import { editTextWithExternalEditor } from './input/externalEditor';
import {
  buildCommandPaletteModel,
  completeCommandPaletteInput,
  moveCommandPaletteSelection,
  submitCommandPaletteInput,
} from './input/commandPalette';
import {
  buildFileMentionModel,
  completeFileMentionInput,
  moveFileMentionSelection,
} from './input/fileMention';
import { resolveTuiInputAction } from './input/inputRouter';
import { submitCurrentInputFromController } from './input/commandSubmit';
import { buildBusyStatusLine } from './render/eventText';
import { formatNow } from './render/terminalText';
import { TUI_TEXT } from './render/text';
import { createInitialTuiState, createSession } from './state/tuiState';
import {
  selectFocusedActiveOperations,
  selectFocusedBusy,
  selectFocusedPendingApproval,
  selectFocusedPendingUi,
  selectFocusedSession,
  selectFocusedTimeline,
  selectReady,
  tuiStateReducer,
} from './state/tuiStateReducer';
import { splitTimelineForStaticRender } from './timeline/agentTimelineSelectors';
import { TuiRuntimeController } from './TuiRuntimeController';
import { useResumePickerController } from './useResumePickerController';
import { useTextAreaController } from './useTextAreaController';
import {
  GLOBAL_REVIEW_POLICY_PICKER_OPTIONS,
  findGlobalReviewPolicyPickerIndex,
} from './globalReviewPolicyPicker';
import type { TuiState } from './state/tuiState';
import type { MessageRole } from './types';

const SPINNER_FRAMES = ['-', '\\', '|', '/'];
const CLEAR_SCREEN = '\x1B[2J\x1B[3J\x1B[H';

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
  const [timelineRenderEpoch, setTimelineRenderEpoch] = useState(0);
  const [terminalSize, setTerminalSize] = useState(() => ({
    columns: stdout.columns ?? 80,
    rows: stdout.rows ?? 24,
  }));
  const [studioMode, setStudioMode] = useState(false);
  const [approvalIndex, setApprovalIndex] = useState(0);
  const [commandPaletteIndex, setCommandPaletteIndex] = useState(0);
  const [externalEditorOpen, setExternalEditorOpen] = useState(false);
  const [fileMentionIndex, setFileMentionIndex] = useState(0);
  const [globalReviewPolicyMode, setGlobalReviewPolicyMode] = useState<BuiltinGlobalReviewPolicyMode>(
    () => config.globalReviewPolicyMode,
  );
  const [globalReviewPolicyPickerOpen, setGlobalReviewPolicyPickerOpen] = useState(false);
  const [globalReviewPolicyIndex, setGlobalReviewPolicyIndex] = useState(
    () => findGlobalReviewPolicyPickerIndex(config.globalReviewPolicyMode),
  );

  const stateRef = useRef<TuiState>(tuiState);
  const inputBufferRef = useRef(createInitialTuiInputBufferState());
  const lastInterruptAtRef = useRef(0);
  const localServerPort = config.localServerPort;
  // Studio 模式持续期间共用一个 conversationId,这样 wiki 跨 turn 累积、
  // pet runtime 的 thread namespace 也保持一致
  const studioConversationIdRef = useRef<string | null>(null);
  const studioModeRef = useRef(false);
  const resetTimelineView = useCallback(() => {
    stdout.write(CLEAR_SCREEN);
    setTimelineRenderEpoch((current) => current + 1);
  }, [stdout]);
  const runtimeController = useMemo(() => new TuiRuntimeController({
    actorId: props.actorId,
    localServerPort,
    dispatch,
    getState: () => stateRef.current,
    resetTimelineView,
    setNow,
  }), [props.actorId, localServerPort, dispatch, resetTimelineView, setNow]);
  const focusedSession = selectFocusedSession(tuiState);
  const timeline = selectFocusedTimeline(tuiState);
  const { staticEntries: staticTimeline, dynamicEntries: dynamicTimeline } = useMemo(
    () => splitTimelineForStaticRender(timeline),
    [timeline],
  );
  const ready = selectReady(tuiState);
  const busy = selectFocusedBusy(tuiState);
  const pendingUi = selectFocusedPendingUi(tuiState);
  const activeOperations = selectFocusedActiveOperations(tuiState);
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
    if (globalReviewPolicyPickerOpen && (busy || pendingApproval)) {
      setGlobalReviewPolicyPickerOpen(false);
    }
  }, [busy, globalReviewPolicyPickerOpen, pendingApproval?.requestId]);

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
    resetTimelineView,
    runtimeController,
  });

  // Input area focus: only when ready, not busy, and no modal panel.
  const inputFocused = ready
    && !busy
    && !resumePickerOpen
    && !globalReviewPolicyPickerOpen
    && !externalEditorOpen;
  const textArea = useTextAreaController({
    input: tuiState.input,
    focused: inputFocused,
    placeholder: pendingApproval ? TUI_TEXT.approvalFreeReplyPlaceholder : TUI_TEXT.inputPlaceholder,
    width: textAreaWidth,
    dispatch,
  });
  const inputValue = textArea.value;
  const commandPalette = useMemo(() => (
    inputFocused && !pendingApproval
      ? buildCommandPaletteModel({
          text: inputValue,
          cursorOffset: textArea.cursorOffset,
        }, commandPaletteIndex)
      : buildCommandPaletteModel({ text: '', cursorOffset: 0 })
  ), [commandPaletteIndex, inputFocused, inputValue, pendingApproval, textArea.cursorOffset]);
  const fileMentionRoot = focusedSession?.runtime.cwd ?? config.workdir;
  const fileMention = useMemo(() => (
    inputFocused && !pendingApproval
      ? buildFileMentionModel({
          text: inputValue,
          cursorOffset: textArea.cursorOffset,
        }, fileMentionRoot, fileMentionIndex)
      : buildFileMentionModel({ text: '', cursorOffset: 0 }, fileMentionRoot)
  ), [fileMentionIndex, fileMentionRoot, inputFocused, inputValue, pendingApproval, textArea.cursorOffset]);

  useEffect(() => {
    setCommandPaletteIndex(0);
    setFileMentionIndex(0);
  }, [inputValue, textArea.cursorOffset]);

  const openExternalEditor = (initialText: string) => {
    if (externalEditorOpen) return;
    setExternalEditorOpen(true);
    appendMessage('system', TUI_TEXT.externalEditorOpening);
    void editTextWithExternalEditor({
      initialText,
      cwd: focusedSession?.runtime.cwd ?? config.workdir,
    }).then((text) => {
      const value = text.replace(/\r\n/g, '\n').replace(/\n$/, '');
      if (!value) {
        appendMessage('system', TUI_TEXT.externalEditorEmpty);
        return;
      }
      dispatch({ type: 'input.set', value, cursorOffset: value.length });
      appendMessage('system', TUI_TEXT.externalEditorLoaded);
    }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      appendMessage('system', TUI_TEXT.externalEditorFailed(message));
    }).finally(() => {
      setExternalEditorOpen(false);
    });
  };

  const openGlobalReviewPolicyPicker = () => {
    setGlobalReviewPolicyIndex(findGlobalReviewPolicyPickerIndex(globalReviewPolicyMode));
    setGlobalReviewPolicyPickerOpen(true);
  };

  const applyGlobalReviewPolicySelection = () => {
    const option = GLOBAL_REVIEW_POLICY_PICKER_OPTIONS[globalReviewPolicyIndex];
    if (!option) return;
    try {
      saveStoredConfig({
        ...loadStoredConfig(),
        global_review_policy: option.mode,
      });
      config.globalReviewPolicyMode = option.mode;
      setGlobalReviewPolicyMode(option.mode);
      const synced = runtimeController.updateRuntimeConfig({
        globalReviewPolicyMode: option.mode,
      });
      appendMessage('system', TUI_TEXT.globalReviewPolicySaved(option.label, synced));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appendMessage('system', TUI_TEXT.globalReviewPolicySaveFailed(message));
    } finally {
      setGlobalReviewPolicyPickerOpen(false);
    }
  };

  const submitInputValue = (value: string) => {
    submitCurrentInputFromController({
      inputValue: value,
      focusedSession,
      studioModeRef,
      studioConversationIdRef,
      setStudioMode,
      openResumePicker,
      openGlobalReviewPolicyPicker,
      openExternalEditor,
      exit,
      appendSystemMessage: (text) => appendMessage('system', text),
      clearInputValue: textArea.clear,
      dispatch,
      runtimeController,
    });
  };

  const submitCurrentInput = () => {
    submitInputValue(inputValue);
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
    if (externalEditorOpen) {
      return;
    }
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
      approvalFreeTextActive: Boolean(pendingApproval && inputValue.trim()),
      hasResumePicker: resumePickerOpen,
      hasGlobalReviewPolicyPicker: globalReviewPolicyPickerOpen,
      hasCommandPalette: commandPalette.open,
      hasFileMention: fileMention.open,
      composerHistory: {
        boundary: textArea.historyBoundary,
        available: getComposerHistoryAvailability(tuiState.input.history),
      },
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

      case 'globalReviewPolicy':
        if (action.action === 'previous') {
          setGlobalReviewPolicyIndex((current) => Math.max(0, current - 1));
          return;
        }
        if (action.action === 'next') {
          setGlobalReviewPolicyIndex((current) =>
            Math.max(0, Math.min(GLOBAL_REVIEW_POLICY_PICKER_OPTIONS.length - 1, current + 1)));
          return;
        }
        if (action.action === 'submit') {
          applyGlobalReviewPolicySelection();
          return;
        }
        setGlobalReviewPolicyPickerOpen(false);
        return;

      case 'commandPalette':
        if (action.action === 'previous') {
          if (!commandPalette.open) return;
          const { query, items } = commandPalette;
          setCommandPaletteIndex((current) => moveCommandPaletteSelection({
            open: true,
            query,
            items,
            selectedIndex: current,
          }, -1));
          return;
        }
        if (action.action === 'next') {
          if (!commandPalette.open) return;
          const { query, items } = commandPalette;
          setCommandPaletteIndex((current) => moveCommandPaletteSelection({
            open: true,
            query,
            items,
            selectedIndex: current,
          }, 1));
          return;
        }
        {
          if (action.action === 'submit') {
            const submission = submitCommandPaletteInput(commandPalette);
            if (submission) {
              submitInputValue(submission.text);
              return;
            }
            submitCurrentInput();
            return;
          }
          const completion = completeCommandPaletteInput(commandPalette);
          if (completion) {
            dispatch({
              type: 'input.set',
              value: completion.text,
              cursorOffset: completion.cursorOffset,
            });
          }
          return;
        }

      case 'fileMention':
        if (action.action === 'previous') {
          if (!fileMention.open) return;
          const { query, replacementStart, replacementEnd, items } = fileMention;
          setFileMentionIndex((current) => moveFileMentionSelection({
            open: true,
            query,
            replacementStart,
            replacementEnd,
            items,
            selectedIndex: current,
          }, -1));
          return;
        }
        if (action.action === 'next') {
          if (!fileMention.open) return;
          const { query, replacementStart, replacementEnd, items } = fileMention;
          setFileMentionIndex((current) => moveFileMentionSelection({
            open: true,
            query,
            replacementStart,
            replacementEnd,
            items,
            selectedIndex: current,
          }, 1));
          return;
        }
        {
          const completion = completeFileMentionInput({
            text: inputValue,
            cursorOffset: textArea.cursorOffset,
          }, fileMention);
          if (completion) {
            dispatch({
              type: 'input.set',
              value: completion.text,
              cursorOffset: completion.cursorOffset,
            });
          }
          return;
        }

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

      case 'composerHistory':
        dispatch({ type: 'input.history.navigate', direction: action.action });
        return;

      case 'textarea':
        textArea.applyCommand(action.command);
        return;

      case 'none':
        return;
    }
  }, { isActive: true });

  const spinnerFrame = SPINNER_FRAMES[animationFrame];
  const activityStatus = pendingUi
    ? buildBusyStatusLine(pendingUi, now, spinnerFrame, activeOperations)
    : status;

  return (
    <Box flexDirection="column" paddingX={1}>
      {timeline.length === 0 ? <Text dimColor>{TUI_TEXT.emptyHistory(petName)}</Text> : null}
      <Static key={timelineRenderEpoch} items={staticTimeline}>
        {(entry) => (
          <AgentTimelineItem
            key={entry.id}
            entry={entry}
            petName={petName}
            now={now}
            width={contentWidth}
          />
        )}
      </Static>
      {dynamicTimeline.length > 0 ? (
        <AgentTimeline entries={dynamicTimeline} petName={petName} width={contentWidth} now={now} />
      ) : null}
      {resumePickerOpen ? (
        <ResumePicker
          sessions={resumePicker.sessions}
          selectedIndex={resumePicker.selectedIndex}
          loading={resumePicker.status === 'loading'}
          width={contentWidth}
        />
      ) : null}
      {globalReviewPolicyPickerOpen ? (
        <GlobalReviewPolicyPicker
          currentMode={globalReviewPolicyMode}
          selectedIndex={globalReviewPolicyIndex}
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
          <Text dimColor>{activityStatus}</Text>
        </>
      ) : null}
      {commandPalette.open ? (
        <CommandPalette model={commandPalette} width={contentWidth} />
      ) : null}
      {fileMention.open ? (
        <FileMentionPopup model={fileMention} width={contentWidth} />
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
      <BottomStatusLine
        status={activityStatus}
        session={focusedSession}
        globalReviewPolicyMode={globalReviewPolicyMode}
        width={contentWidth}
      />
    </Box>
  );
}
