import React, {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { Box, Static, Text, useApp, useInput, useStdout } from 'ink';
import type { BuiltinGlobalReviewPolicyMode } from '@pinpawo/pet-agent';
import { getConfig } from '../config';
import { loadStoredConfig, saveStoredConfig } from '../storage';
import { AgentTimelineItem } from './components/AgentTimelineItem';
import { BottomStatusLine } from './components/BottomStatusLine';
import { Composer } from './components/Composer';
import { OverlayLayer } from './components/OverlayLayer';
import { TranscriptViewer } from './components/TranscriptViewer';
import { WelcomePanel } from './components/WelcomePanel';
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
import { resolveTuiInteractionOwner } from './interactionOwner';
import { buildTuiOverlayModel } from './overlayModel';
import { resolveTuiInputAction } from './input/inputRouter';
import { submitCurrentInputFromController } from './input/commandSubmit';
import { TUI_TEXT } from './render/text';
import { buildTuiScreenModel } from './screenModel';
import { buildStatusBarModel } from './statusBarModel';
import { createInitialTuiState, createSession } from './state/tuiState';
import {
  tuiStateReducer,
} from './state/tuiStateReducer';
import type { AgentTimelineEntry } from '@pinpawo/agent-session';
import { TuiRuntimeController } from './TuiRuntimeController';
import { TuiLocalWebSocketClient } from './tuiLocalWebSocketClient';
import { createTuiMessage } from './tuiMessage';
import { useResumePickerController } from './useResumePickerController';
import { useTextAreaController } from './useTextAreaController';
import {
  GLOBAL_REVIEW_POLICY_PICKER_OPTIONS,
  findGlobalReviewPolicyPickerIndex,
} from './globalReviewPolicyPicker';
import type { TuiState } from './state/tuiState';
import type { MessageRole } from './types';
import {
  createTimelineScrollState,
  maxTimelineScrollOffset,
  scrollTimelineByLines,
  scrollTimelineByPage,
  updateTimelineScrollMetrics,
} from './timeline/timelineScroll';
import { advanceInlineTimeline } from './timeline/inlineTimeline';
import { useTranscriptTerminalMode } from './transcript/transcriptTerminalMode';

const SPINNER_FRAMES = ['-', '\\', '|', '/'];
const CLEAR_SCREEN = '\x1B[2J\x1B[3J\x1B[H';

function renderTimelineDisplayEntry(
  entry: AgentTimelineEntry,
  props: {
    petName: string;
    now: number;
    width: number;
  },
) {
  return (
    <AgentTimelineItem
      key={entry.id}
      entry={entry}
      petName={props.petName}
      now={props.now}
      width={props.width}
    />
  );
}

// ---------------------------------------------------------------------------
// Main TUI application
// ---------------------------------------------------------------------------

export function TuiApp(props: { actorId: string; workdir?: string }) {
  const config = getConfig();
  const { exit } = useApp();
  const { stdout } = useStdout();
  const defaultSessionId = useMemo(() => `chat:${props.actorId}`, [props.actorId]);
  const [tuiState, reactDispatch] = useReducer(
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
  const [approvalIndex, setApprovalIndex] = useState(0);
  const [commandPaletteIndex, setCommandPaletteIndex] = useState(0);
  const [fileMentionIndex, setFileMentionIndex] = useState(0);
  const [transcriptViewerOpen, setTranscriptViewerOpen] = useState(false);
  const [transcriptScroll, setTranscriptScroll] = useState(createTimelineScrollState);
  const [transcriptInitialPageUp, setTranscriptInitialPageUp] = useState(false);
  const inlineTimelineLedgerRef = useRef<{
    key: string;
    entries: AgentTimelineEntry[];
  }>({ key: '', entries: [] });
  const transcriptTerminalMode = useTranscriptTerminalMode(stdout);
  const [globalReviewPolicyMode, setGlobalReviewPolicyMode] = useState<BuiltinGlobalReviewPolicyMode>(
    () => config.globalReviewPolicyMode,
  );
  const [globalReviewPolicyPickerOpen, setGlobalReviewPolicyPickerOpen] = useState(false);
  const [globalReviewPolicyIndex, setGlobalReviewPolicyIndex] = useState(
    () => findGlobalReviewPolicyPickerIndex(config.globalReviewPolicyMode),
  );

  const stateRef = useRef<TuiState>(tuiState);
  const dispatch = useCallback((action: Parameters<typeof tuiStateReducer>[1]) => {
    stateRef.current = tuiStateReducer(stateRef.current, action);
    reactDispatch(action);
  }, [reactDispatch]);
  const inputBufferRef = useRef(createInitialTuiInputBufferState());
  const lastInterruptAtRef = useRef(0);
  const localServerPort = config.localServerPort;
  const workdir = props.workdir ?? config.workdir;
  const resetTimelineView = useCallback(() => {
    transcriptTerminalMode.leave();
    stdout.write(CLEAR_SCREEN);
    setTranscriptViewerOpen(false);
    setTranscriptScroll(createTimelineScrollState());
    setTranscriptInitialPageUp(false);
    inlineTimelineLedgerRef.current = { key: '', entries: [] };
    setTimelineRenderEpoch((current) => current + 1);
  }, [stdout, transcriptTerminalMode]);
  const runtimeController = useMemo(() => new TuiRuntimeController({
    actorId: props.actorId,
    localServerPort,
    dispatch,
    getState: () => stateRef.current,
    resetTimelineView,
    setNow,
    workdir,
    connectionFactory: (handlers) => new TuiLocalWebSocketClient({
      port: localServerPort,
      handlers,
    }),
  }), [props.actorId, localServerPort, dispatch, resetTimelineView, setNow, workdir]);
  const screenModel = useMemo(() => buildTuiScreenModel({
    state: tuiState,
    terminalColumns: terminalSize.columns,
    now,
    animationFrame,
    timelineRenderEpoch,
  }), [animationFrame, now, terminalSize.columns, timelineRenderEpoch, tuiState]);
  const focusedSession = screenModel.session;
  const activeRequestId = focusedSession?.activeRun?.requestId ?? null;
  const lastTimelineRequestIdRef = useRef(activeRequestId);
  const ready = screenModel.ready;
  const busy = screenModel.busy;
  const pendingApproval = screenModel.pendingApproval;
  const contentWidth = screenModel.regions.timeline.width;
  const textAreaWidth = screenModel.regions.composer.textAreaWidth;
  const reviewOptions = pendingApproval?.review.options ?? [];
  const composerTarget = tuiState.ui.composerTarget;
  const externalEditorOpen = tuiState.ui.externalEditorOpen;

  useEffect(() => {
    setApprovalIndex(0);
  }, [pendingApproval?.requestId, pendingApproval?.review.id]);

  useEffect(() => {
    if (activeRequestId && activeRequestId !== lastTimelineRequestIdRef.current) {
      setTranscriptScroll(createTimelineScrollState());
    }
    lastTimelineRequestIdRef.current = activeRequestId;
  }, [activeRequestId]);

  useEffect(() => {
    if (
      transcriptViewerOpen
      && transcriptInitialPageUp
      && transcriptScroll.viewportHeight > 0
    ) {
      setTranscriptScroll((current) => scrollTimelineByPage(current, 'up'));
      setTranscriptInitialPageUp(false);
    }
  }, [
    transcriptInitialPageUp,
    transcriptScroll.viewportHeight,
    transcriptViewerOpen,
  ]);

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
      type: 'message.appended',
      message: createTuiMessage({
        role,
        text,
      }),
    });
  };

  const clearInputValue = () => {
    dispatch({ type: 'input.set', value: '', cursorOffset: 0 });
  };

  const resetComposerTarget = () => {
    dispatch({ type: 'ui.composer_target.reset' });
  };

  const selectStudioComposerTarget = (conversationId: string) => {
    dispatch({
      type: 'ui.composer_target.set',
      composerTarget: 'studio',
      studioConversationId: conversationId,
    });
  };

  const selectChatComposerTarget = () => {
    dispatch({ type: 'ui.composer_target.reset' });
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
    resetComposerTarget,
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
  const fileMentionRoot = focusedSession?.runtime.cwd ?? workdir;
  const fileMention = useMemo(() => (
    inputFocused && !pendingApproval
      ? buildFileMentionModel({
          text: inputValue,
          cursorOffset: textArea.cursorOffset,
        }, fileMentionRoot, fileMentionIndex)
      : buildFileMentionModel({ text: '', cursorOffset: 0 }, fileMentionRoot)
  ), [fileMentionIndex, fileMentionRoot, inputFocused, inputValue, pendingApproval, textArea.cursorOffset]);
  const interactionOwner = useMemo(() => resolveTuiInteractionOwner({
    ready,
    busy,
    pendingApproval: Boolean(pendingApproval),
    approvalFreeTextActive: Boolean(pendingApproval && inputValue.trim()),
    resumePickerOpen,
    globalReviewPolicyPickerOpen,
    commandPaletteOpen: commandPalette.open,
    fileMentionOpen: fileMention.open,
    transcriptViewerOpen,
    externalEditorOpen,
  }), [
    busy,
    commandPalette.open,
    externalEditorOpen,
    fileMention.open,
    globalReviewPolicyPickerOpen,
    inputValue,
    pendingApproval,
    ready,
    resumePickerOpen,
    transcriptViewerOpen,
  ]);
  const overlayModel = useMemo(() => buildTuiOverlayModel({
    width: screenModel.regions.overlay.width,
    owner: interactionOwner,
    resumePicker: {
      open: resumePickerOpen,
      sessions: resumePicker.sessions,
      selectedIndex: resumePicker.selectedIndex,
      loading: resumePicker.status === 'loading',
    },
    approval: {
      request: pendingApproval,
      selectedIndex: approvalIndex,
    },
    globalReviewPolicyPicker: {
      open: globalReviewPolicyPickerOpen,
      currentMode: globalReviewPolicyMode,
      selectedIndex: globalReviewPolicyIndex,
    },
    commandPalette,
    fileMention,
  }), [
    approvalIndex,
    commandPalette,
    fileMention,
    globalReviewPolicyIndex,
    globalReviewPolicyMode,
    globalReviewPolicyPickerOpen,
    interactionOwner,
    pendingApproval,
    resumePicker.sessions,
    resumePicker.selectedIndex,
    resumePicker.status,
    resumePickerOpen,
    screenModel.regions.overlay.width,
  ]);

  useEffect(() => {
    setCommandPaletteIndex(0);
    setFileMentionIndex(0);
  }, [inputValue, textArea.cursorOffset]);

  const openExternalEditor = (initialText: string) => {
    if (externalEditorOpen) return;
    dispatch({ type: 'ui.external_editor.set_open', open: true });
    appendMessage('system', TUI_TEXT.externalEditorOpening);
    void editTextWithExternalEditor({
      initialText,
      cwd: focusedSession?.runtime.cwd ?? workdir,
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
      dispatch({ type: 'ui.external_editor.set_open', open: false });
    });
  };

  const openGlobalReviewPolicyPicker = () => {
    setGlobalReviewPolicyIndex(findGlobalReviewPolicyPickerIndex(globalReviewPolicyMode));
    setGlobalReviewPolicyPickerOpen(true);
  };

  const openTranscriptViewer = (initialPageUp = false) => {
    transcriptTerminalMode.enter();
    setTranscriptScroll(createTimelineScrollState());
    setTranscriptInitialPageUp(initialPageUp);
    setTranscriptViewerOpen(true);
  };

  const closeTranscriptViewer = () => {
    transcriptTerminalMode.leave();
    setTranscriptViewerOpen(false);
    setTranscriptScroll(createTimelineScrollState());
    setTranscriptInitialPageUp(false);
  };

  const applyGlobalReviewPolicySelection = () => {
    const option = GLOBAL_REVIEW_POLICY_PICKER_OPTIONS[globalReviewPolicyIndex];
    if (!option) return;
    try {
      saveStoredConfig({
        ...loadStoredConfig(),
        global_review_policy: option.mode,
      });
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
      composerTarget,
      studioConversationId: tuiState.ui.studioConversationId,
      selectStudioComposerTarget,
      selectChatComposerTarget,
      openResumePicker,
      openGlobalReviewPolicyPicker,
      openTranscriptViewer,
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
    const normalized = normalizeTuiInputEvent(input, key, inputBufferRef.current);
    inputBufferRef.current = normalized.state;
    if (!normalized.event) {
      return;
    }
    const inputEvent = toCanonicalInputEvent(normalized.event);
    const action = resolveTuiInputAction(inputEvent, interactionOwner, {
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

      case 'timeline':
        if (action.action === 'page_up' || action.action === 'scroll_up') {
          openTranscriptViewer(true);
        }
        return;

      case 'transcript':
        if (action.action === 'dismiss') {
          closeTranscriptViewer();
          return;
        }
        if (action.action === 'top') {
          setTranscriptScroll((current) => ({
            ...current,
            offset: maxTimelineScrollOffset(current.contentHeight, current.viewportHeight),
            followingTail: false,
          }));
          return;
        }
        if (action.action === 'bottom') {
          setTranscriptScroll((current) => ({
            ...current,
            offset: 0,
            followingTail: true,
          }));
          return;
        }
        setTranscriptScroll((current) => {
          const direction = action.action === 'line_up' || action.action === 'page_up'
            ? 'up'
            : 'down';
          return action.action === 'page_up' || action.action === 'page_down'
            ? scrollTimelineByPage(current, direction)
            : scrollTimelineByLines(current, direction, 3);
        });
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

  const statusBarModel = useMemo(() => buildStatusBarModel({
    activityStatus: screenModel.regions.statusBar.activityStatus,
    statusNotice: screenModel.regions.statusBar.statusNotice,
    connectionStatus: screenModel.regions.statusBar.connectionStatus,
    composerTarget,
    session: focusedSession,
    globalReviewPolicyMode,
    overlayOwner: overlayModel.current?.label ?? null,
  }), [
    focusedSession,
    globalReviewPolicyMode,
    overlayModel.current?.label,
    screenModel.regions.statusBar.activityStatus,
    screenModel.regions.statusBar.connectionStatus,
    screenModel.regions.statusBar.statusNotice,
    composerTarget,
  ]);
  const inlineTimelineKey = `${focusedSession?.sessionId ?? defaultSessionId}:${screenModel.regions.timeline.renderKey}`;
  if (inlineTimelineLedgerRef.current.key !== inlineTimelineKey) {
    inlineTimelineLedgerRef.current = {
      key: inlineTimelineKey,
      entries: [],
    };
  }
  // Ink Static advances by array length, so keep an append-only ledger even
  // when an authoritative snapshot replaces the projection with a shorter one.
  const inlineTimeline = transcriptViewerOpen
    ? {
        committedEntries: inlineTimelineLedgerRef.current.entries,
        liveEntries: [],
      }
    : advanceInlineTimeline(
        inlineTimelineLedgerRef.current.entries,
        screenModel.regions.timeline.entries,
      );
  inlineTimelineLedgerRef.current.entries = inlineTimeline.committedEntries;
  const transcriptLayoutVersion = useMemo(() => ({
    terminalColumns: terminalSize.columns,
    terminalRows: terminalSize.rows,
  }), [
    terminalSize.columns,
    terminalSize.rows,
  ]);
  const handleTranscriptMetricsChange = useCallback((metrics: {
    contentHeight: number;
    viewportHeight: number;
  }) => {
    setTranscriptScroll((current) => updateTimelineScrollMetrics(current, metrics));
  }, []);
  return (
    <>
      <Static
        key={inlineTimelineKey}
        items={inlineTimeline.committedEntries}
      >
        {(entry) => (
          <Box key={entry.id} flexDirection="column" paddingX={1}>
            {renderTimelineDisplayEntry(entry, {
              petName: screenModel.petName,
              now,
              width: contentWidth,
            })}
          </Box>
        )}
      </Static>
      {transcriptViewerOpen ? (
        <TranscriptViewer
          entries={screenModel.regions.timeline.entries}
          petName={screenModel.petName}
          now={now}
          width={contentWidth}
          height={terminalSize.rows}
          scrollOffset={transcriptScroll.offset}
          contentVersion={screenModel.regions.timeline.entries}
          layoutVersion={transcriptLayoutVersion}
          contentHeight={transcriptScroll.contentHeight}
          viewportHeight={transcriptScroll.viewportHeight}
          onMetricsChange={handleTranscriptMetricsChange}
        />
      ) : (
        <Box
          flexDirection="column"
          paddingX={1}
        >
          {screenModel.regions.timeline.emptyState ? (
            <Box flexShrink={0}>
              <WelcomePanel model={screenModel.regions.timeline.emptyState} />
            </Box>
          ) : null}
          {inlineTimeline.liveEntries.map((entry) => (
            <Box key={entry.id} flexShrink={0}>
              {renderTimelineDisplayEntry(entry, {
                petName: screenModel.petName,
                now,
                width: contentWidth,
              })}
            </Box>
          ))}
          <Box flexShrink={0}>
            <OverlayLayer model={overlayModel} />
          </Box>
          <Box
            borderStyle="round"
            borderColor={screenModel.regions.composer.borderColor}
            flexShrink={0}
            paddingX={1}
            marginTop={screenModel.regions.composer.marginTop}
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
          <Box flexShrink={0}>
            <BottomStatusLine
              model={statusBarModel}
              width={screenModel.regions.statusBar.width}
            />
          </Box>
        </Box>
      )}
    </>
  );
}
