import { randomUUID } from 'node:crypto';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput, useStdout } from 'ink';
import type { BuiltinGlobalReviewPolicyMode } from '@pinpawo/pet-agent';
import { config } from '../config';
import { loadStoredConfig, saveStoredConfig } from '../storage';
import { AgentTimelineItem } from './components/AgentTimelineItem';
import { BottomStatusLine } from './components/BottomStatusLine';
import { Composer } from './components/Composer';
import { MessageBlock } from './components/MessageBlock';
import { OverlayLayer } from './components/OverlayLayer';
import { SubagentActivityItem } from './components/SubagentActivityItem';
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
import { buildTuiOverlayModel } from './overlayModel';
import { resolveTuiInputAction } from './input/inputRouter';
import { submitCurrentInputFromController } from './input/commandSubmit';
import { formatNow } from './render/terminalText';
import { TUI_TEXT } from './render/text';
import {
  buildTuiScreenModel,
  type TuiScreenModel,
} from './screenModel';
import { buildStatusBarModel } from './statusBarModel';
import { createInitialTuiState, createSession } from './state/tuiState';
import {
  tuiStateReducer,
} from './state/tuiStateReducer';
import type { AgentTimelineDisplayEntry } from './timeline/agentTimelineSelectors';
import type { TuiTimelineViewMode } from './timeline/timelineView';
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

function renderTimelineDisplayEntry(
  displayEntry: AgentTimelineDisplayEntry,
  props: {
    petName: string;
    now: number;
    width: number;
  },
) {
  if (displayEntry.type === 'notice') {
    const notice = displayEntry.notice;
    return (
      <MessageBlock
        key={displayEntry.id}
        entry={{
          kind: 'system',
          timestamp: notice.timestamp,
          text: notice.text,
        }}
        petName={props.petName}
        width={props.width}
      />
    );
  }
  if (displayEntry.type === 'activity') {
    return (
      <SubagentActivityItem
        key={displayEntry.id}
        activity={displayEntry.activity}
        width={props.width}
      />
    );
  }
  return (
    <AgentTimelineItem
      key={displayEntry.id}
      entry={displayEntry.entry}
      petName={props.petName}
      now={props.now}
      width={props.width}
    />
  );
}

type TimelineDisplayRegion = Pick<
  TuiScreenModel['regions']['timeline'],
  'entries' | 'staticEntries' | 'dynamicEntries'
>;

function hasProcessTimelineContent(entries: AgentTimelineDisplayEntry[]) {
  return entries.some((displayEntry) => {
    if (displayEntry.type === 'activity') return true;
    if (displayEntry.type !== 'timeline') return false;
    const timelineEntry = displayEntry.entry;
    if (timelineEntry.type === 'operation') return true;
    return timelineEntry.type === 'message' && timelineEntry.status === 'streaming';
  });
}

// ---------------------------------------------------------------------------
// Main TUI application
// ---------------------------------------------------------------------------

export function TuiApp(props: { actorId: string; workdir?: string }) {
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
  const [timelineViewMode, setTimelineViewMode] = useState<TuiTimelineViewMode>('snapshot');
  const [processTimelineRegion, setProcessTimelineRegion] = useState<TimelineDisplayRegion | null>(null);
  const [terminalSize, setTerminalSize] = useState(() => ({
    columns: stdout.columns ?? 80,
    rows: stdout.rows ?? 24,
  }));
  const [approvalIndex, setApprovalIndex] = useState(0);
  const [commandPaletteIndex, setCommandPaletteIndex] = useState(0);
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
  const workdir = props.workdir ?? config.workdir;
  const clearTimelineOutput = useCallback(() => {
    stdout.write(CLEAR_SCREEN);
    setTimelineRenderEpoch((current) => current + 1);
  }, [stdout]);
  const switchTimelineViewMode = useCallback((
    mode: TuiTimelineViewMode,
    options: { clearOutput?: boolean } = {},
  ) => {
    setTimelineViewMode(mode);
    if (options.clearOutput ?? true) {
      clearTimelineOutput();
    }
  }, [clearTimelineOutput]);
  const resetTimelineView = useCallback(() => {
    switchTimelineViewMode('snapshot');
  }, [switchTimelineViewMode]);
  const runtimeController = useMemo(() => new TuiRuntimeController({
    actorId: props.actorId,
    localServerPort,
    dispatch,
    getState: () => stateRef.current,
    resetTimelineView,
    setNow,
    workdir,
  }), [props.actorId, localServerPort, dispatch, resetTimelineView, setNow, workdir]);
  const screenModel = useMemo(() => buildTuiScreenModel({
    state: tuiState,
    terminalColumns: terminalSize.columns,
    now,
    animationFrame,
    timelineRenderEpoch,
  }), [animationFrame, now, terminalSize.columns, timelineRenderEpoch, tuiState]);
  const focusedSession = screenModel.session;
  const ready = screenModel.ready;
  const busy = screenModel.busy;
  const pendingApproval = screenModel.pendingApproval;
  const contentWidth = screenModel.regions.timeline.width;
  const textAreaWidth = screenModel.regions.composer.textAreaWidth;
  const reviewOptions = pendingApproval?.review.options ?? [];
  const uiMode = tuiState.ui.mode;
  const externalEditorOpen = tuiState.ui.externalEditorOpen;
  const focusedSessionId = focusedSession?.id ?? null;
  const focusedTimelineEntryCount = focusedSession?.timeline.length ?? 0;
  const currentTimelineRegion = screenModel.regions.timeline;
  const currentTimelineHasProcessContent = hasProcessTimelineContent(currentTimelineRegion.entries);
  const displayedTimelineRegion = timelineViewMode === 'process' && processTimelineRegion
    ? processTimelineRegion
    : currentTimelineRegion;
  const displayedTimelineRenderKey = `${timelineViewMode}:${screenModel.regions.timeline.renderKey}`;

  useEffect(() => {
    stateRef.current = tuiState;
  }, [tuiState]);

  useEffect(() => {
    setProcessTimelineRegion(null);
    switchTimelineViewMode('snapshot', { clearOutput: false });
  }, [focusedSessionId, switchTimelineViewMode]);

  useEffect(() => {
    if (!busy && focusedTimelineEntryCount === 0) {
      setProcessTimelineRegion(null);
    }
  }, [busy, focusedTimelineEntryCount]);

  useEffect(() => {
    if (busy && timelineViewMode !== 'process') {
      switchTimelineViewMode('process');
    }
  }, [busy, switchTimelineViewMode, timelineViewMode]);

  useEffect(() => {
    if (!busy && !currentTimelineHasProcessContent) return;
    setProcessTimelineRegion({
      entries: currentTimelineRegion.entries,
      staticEntries: currentTimelineRegion.staticEntries,
      dynamicEntries: currentTimelineRegion.dynamicEntries,
    });
  }, [
    busy,
    currentTimelineHasProcessContent,
    currentTimelineRegion.dynamicEntries,
    currentTimelineRegion.entries,
    currentTimelineRegion.staticEntries,
  ]);

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
      type: 'message.append',
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
    dispatch({ type: 'ui.mode.reset' });
  };

  const enterStudioMode = (conversationId: string) => {
    dispatch({
      type: 'ui.mode.set',
      mode: 'studio',
      studioConversationId: conversationId,
    });
  };

  const exitStudioMode = () => {
    dispatch({ type: 'ui.mode.reset' });
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
  const fileMentionRoot = focusedSession?.runtime.cwd ?? workdir;
  const fileMention = useMemo(() => (
    inputFocused && !pendingApproval
      ? buildFileMentionModel({
          text: inputValue,
          cursorOffset: textArea.cursorOffset,
        }, fileMentionRoot, fileMentionIndex)
      : buildFileMentionModel({ text: '', cursorOffset: 0 }, fileMentionRoot)
  ), [fileMentionIndex, fileMentionRoot, inputFocused, inputValue, pendingApproval, textArea.cursorOffset]);
  const overlayModel = useMemo(() => buildTuiOverlayModel({
    width: screenModel.regions.overlay.width,
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
      mode: uiMode,
      studioConversationId: tuiState.ui.studioConversationId,
      enterStudioMode,
      exitStudioMode,
      openResumePicker,
      openGlobalReviewPolicyPicker,
      openExternalEditor,
      setTimelineViewMode: (mode) => {
        if (mode === 'process' && !processTimelineRegion) {
          return false;
        }
        switchTimelineViewMode(mode);
        return true;
      },
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
    const action = resolveTuiInputAction(inputEvent, {
      ready,
      busy,
      hasPendingApproval: Boolean(pendingApproval),
      approvalFreeTextActive: Boolean(pendingApproval && inputValue.trim()),
      hasResumePicker: resumePickerOpen,
      hasGlobalReviewPolicyPicker: globalReviewPolicyPickerOpen,
      hasCommandPalette: commandPalette.open,
      hasFileMention: fileMention.open,
      hasExternalEditor: externalEditorOpen,
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

  const statusBarModel = useMemo(() => buildStatusBarModel({
    activityStatus: screenModel.regions.statusBar.activityStatus,
    connectionStatus: screenModel.regions.statusBar.connectionStatus,
    mode: uiMode,
    timelineViewMode,
    session: focusedSession,
    globalReviewPolicyMode,
    overlayOwner: overlayModel.ownerLabel,
  }), [
    focusedSession,
    globalReviewPolicyMode,
    overlayModel.ownerLabel,
    screenModel.regions.statusBar.activityStatus,
    screenModel.regions.statusBar.connectionStatus,
    timelineViewMode,
    uiMode,
  ]);

  return (
    <Box flexDirection="column" paddingX={1}>
      {displayedTimelineRegion.entries.length === 0 ? (
        <Text dimColor>{screenModel.regions.timeline.emptyText}</Text>
      ) : null}
      <Static key={displayedTimelineRenderKey} items={displayedTimelineRegion.staticEntries}>
        {(entry) => renderTimelineDisplayEntry(entry, {
          petName: screenModel.petName,
          now,
          width: contentWidth,
        })}
      </Static>
      {displayedTimelineRegion.dynamicEntries.map((entry) => renderTimelineDisplayEntry(entry, {
        petName: screenModel.petName,
        now,
        width: contentWidth,
      }))}
      <OverlayLayer model={overlayModel} />
      <Box
        borderStyle="round"
        borderColor={screenModel.regions.composer.borderColor}
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
      <BottomStatusLine
        model={statusBarModel}
        width={screenModel.regions.statusBar.width}
      />
    </Box>
  );
}
