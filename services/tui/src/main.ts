import {
  BoxRenderable,
  RGBA,
  TextareaRenderable,
  TextRenderable,
  createCliRenderer,
  type PasteEvent,
} from '@opentui/core';
import type { AgentLocalAttachment } from '@pinpawo/agent-session';
import {
  formatAttachmentStrip,
  removeLastAttachment,
} from './attachments/attachmentModel';
import { handleAttachmentPasteEvent } from './attachments/attachmentPaste';
import {
  createLocalHostConnectionFactory,
  readLocalServerPort,
} from './client/localHostConnection';
import {
  loadLocalHostMetadata,
  type LocalHostMetadata,
} from './client/localHostMetadata';
import { parseTuiLaunchOptions } from './cli/launchOptions';
import { resolveComposerIntent } from './commands/composerIntent';
import { createDemoConnectionFactory } from './qa/demoConnection';
import { editTextWithExternalEditor } from './editor/externalEditor';
import {
  applyClipboardAction,
  resolveClipboardAction,
  type SelectableEditor,
} from './input/composerClipboard';
import { syncComposerCursorForCommandOverlay } from './input/composerCursor';
import {
  ComposerDecorationController,
  createComposerDecorationStyle,
} from './input/composerDecorations';
import {
  createComposerHistoryState,
  navigateComposerHistory,
  recordComposerHistoryEntry,
  resetComposerHistoryNavigation,
  resolveComposerHistoryDirection,
} from './input/composerHistory';
import {
  COMPOSER_KEY_BINDINGS,
  COMPOSER_PLACEHOLDER,
} from './input/composerKeyBindings';
import {
  placeComposerCursorAtTextOffset,
  readComposerTextInput,
} from './input/composerTextPosition';
import {
  completeFileMention,
  createFileMentionState,
  moveFileMentionSelection,
  resolveFileMentionKey,
  syncFileMention,
  type FileMentionAction,
} from './input/fileMention';
import { resolveGlobalInterruptAction } from './input/globalInterrupt';
import {
  interactionOwnerBlocksPaste,
  resolveInteractionOwner,
  type InteractionOwner,
} from './input/inputRouter';
import { shouldOpenTranscriptPager } from './input/transcriptShortcut';
import { TuiSessionController } from './session/sessionController';
import {
  APPROVAL_FOOTER_ROWS,
  approvalAcceptsTextInput,
  calculateApprovalDialogLayout,
  resolveApprovalKey,
  type ApprovalState,
} from './overlays/approvalModel';
import { ApprovalController } from './overlays/approvalController';
import { ApprovalView } from './overlays/approvalView';
import {
  closeCommandOverlay,
  commandCompletion,
  createCommandOverlayState,
  moveCommandSelection,
  openCommandHelp,
  pageCommandHelp,
  resolveCommandOverlayKey,
  syncCommandPalette,
  type CommandOverlayAction,
} from './overlays/commandOverlayModel';
import { CommandOverlayView } from './overlays/commandOverlayView';
import { FileMentionView } from './overlays/fileMentionView';
import {
  closeNoticeOverlay,
  createNoticeOverlayState,
  markInterruptNoticePendingTooLong,
  openErrorNotice,
  resolveNoticeOverlayKey,
  shouldRestoreComposerAfterNoticeSync,
  syncNoticeOverlay,
} from './overlays/noticeOverlayModel';
import { NoticeOverlayView } from './overlays/noticeOverlayView';
import {
  InterruptPendingNoticeController,
} from './overlays/interruptPendingNoticeController';
import {
  beginPolicySave,
  closePolicyPicker,
  createPolicyPickerState,
  failPolicySave,
  movePolicySelection,
  openPolicyPicker,
  resolvePolicyPickerKey,
  selectedPolicy,
  type PolicyPickerAction,
} from './overlays/policyPickerModel';
import { PolicyPickerView } from './overlays/policyPickerView';
import {
  beginModelPickerLoad,
  beginModelSelection,
  closeModelPicker,
  createModelPickerState,
  failModelPicker,
  loadModelPickerProfiles,
  moveModelPickerSelection,
  resolveModelPickerKey,
  selectedModelProfile,
  type ModelPickerAction,
} from './overlays/modelPickerModel';
import { ModelPickerView } from './overlays/modelPickerView';
import {
  applySessionPickerAction,
  beginSessionPickerLoad,
  beginSessionResume,
  closeSessionPicker,
  createSessionPickerState,
  failSessionPicker,
  loadSessionPickerSessions,
  resolveSessionPickerKey,
  selectedSession,
  type SessionPickerAction,
} from './overlays/sessionPickerModel';
import { SessionPickerView } from './overlays/sessionPickerView';
import { QaLifecycleDriver } from './qa/qaLifecycleDriver';
import { calculateComposerLayout } from './layout/composerLayout';
import { buildCurrentPlanPanel } from './plan/planPanelModel';
import { installTextareaWorkarounds } from './terminal/textareaCompatibility';
import {
  formatComposerPlaceholder,
  formatConnection,
  formatStatusLines,
} from './status/statusModel';
import {
  formatLiveActivity,
  isLiveActivityPulseActive,
} from './timeline/timelineModel';
import {
  LiveActivityController,
} from './timeline/liveActivityController';
import { TimelineScrollback } from './timeline/timelineScrollback';
import { truncateTerminalLine } from './text/terminalText';
import { withRendererSuspended } from './terminal/rendererLifecycle';
import { exportSessionTranscript } from './transcript/transcriptExport';
import { pageSessionTranscript } from './transcript/transcriptPager';
import { TUI_VERSION } from './version';
import { LoadingCellController } from './visuals/loadingCellController';
import { buildLoadingCellLine } from './visuals/loadingCells';
import { buildWelcomeLines } from './welcome/welcomeModel';

const launchOptions = parseTuiLaunchOptions(process.argv.slice(2));
const { demo, smoke } = launchOptions;

if (launchOptions.showVersion) {
  process.stdout.write(`PinPawo TUI v2 ${TUI_VERSION}\n`);
  process.exit(0);
}

const port = readLocalServerPort();
const hostMetadata: LocalHostMetadata = launchOptions.useDemoConnection
  ? {
      localAgentVersion: 'demo',
      capabilities: ['general', 'explore', 'browser'],
    }
  : await loadLocalHostMetadata({ port });
const renderer = await createCliRenderer({
  exitOnCtrlC: false,
  targetFps: 60,
  useMouse: false,
  enableMouseMovement: false,
  screenMode: 'split-footer',
  footerHeight: 9,
  externalOutputMode: 'capture-stdout',
  consoleMode: 'disabled',
});
const root = new BoxRenderable(renderer, {
  id: 'pinpawo-tui',
  width: '100%',
  height: '100%',
  flexDirection: 'column',
  backgroundColor: RGBA.defaultBackground(),
});
const header = new TextRenderable(renderer, {
  id: 'header',
  content: '',
  fg: '#69c0c8',
  bg: RGBA.defaultBackground(),
  height: 1,
});
const live = new TextRenderable(renderer, {
  id: 'live',
  content: 'live · idle',
  bg: RGBA.defaultBackground(),
  height: 1,
});
const currentPlan = new TextRenderable(renderer, {
  id: 'current-plan',
  content: '',
  fg: '#a8b6c5',
  bg: RGBA.defaultBackground(),
  height: 0,
  overflow: 'hidden',
});
const composerFrame = new BoxRenderable(renderer, {
  id: 'composer-frame',
  width: '100%',
  height: 5,
  border: true,
  paddingLeft: 1,
  paddingRight: 1,
  backgroundColor: RGBA.defaultBackground(),
});
const status = new TextRenderable(renderer, {
  id: 'status',
  content: `local-agent :${port}`,
  fg: '#8a8a8a',
  bg: RGBA.defaultBackground(),
  height: 2,
});
const sessionPickerView = new SessionPickerView(renderer);
const policyPickerView = new PolicyPickerView(renderer);
const modelPickerView = new ModelPickerView(renderer);
const commandOverlayView = new CommandOverlayView(renderer);
const fileMentionView = new FileMentionView(renderer);
const noticeOverlayView = new NoticeOverlayView(renderer);

let localNotice: string | null = null;
let pendingComposerNotice: string | null = null;
let composerNoticeSticky = false;
let attachments: AgentLocalAttachment[] = [];
let commandOverlay = createCommandOverlayState();
let fileMention = createFileMentionState();
let dismissedFileMention: {
  text: string;
  cursorOffset: number;
} | null = null;
let noticeOverlay = createNoticeOverlayState();
let sessionPicker = createSessionPickerState();
let policyPicker = createPolicyPickerState();
let modelPicker = createModelPickerState();
let sessionPickerGeneration = 0;
let policyPickerGeneration = 0;
let modelPickerGeneration = 0;
let sessionListRequest: ReturnType<TuiSessionController['listSessions']> | null = null;
let composerMode: 'chat' | 'studio' = 'chat';
let studioConversationId: string | null = null;
let focusedSessionId = 'pending';
let terminalHandoffOpen = false;
let composerHistory = createComposerHistoryState();
const controller = new TuiSessionController({
  connectionFactory: launchOptions.useDemoConnection
    ? createDemoConnectionFactory({
        review: smoke.review || demo.review,
        qa: demo.qa,
      })
    : createLocalHostConnectionFactory({ port }),
});
const interruptPendingNoticeController =
  new InterruptPendingNoticeController({
    onPendingTooLong: (requestId) => {
      const run = controller.getState().session.activeRun;
      if (
        run?.requestId !== requestId
        || run.state !== 'interrupting'
      ) {
        return;
      }
      noticeOverlay = markInterruptNoticePendingTooLong(
        noticeOverlay,
        requestId,
      );
      refreshNoticeOverlay();
    },
  });
const timeline = new TimelineScrollback(renderer);
const liveActivityController = new LiveActivityController({
  onTick: () => {
    if (!terminalHandoffOpen && live.height > 0) {
      refreshLive();
    }
  },
  onLongWait: () => {
    if (!terminalHandoffOpen && live.height > 0) {
      refreshLive();
    }
  },
});
const approvalController = new ApprovalController({
  sessionController: controller,
  getWidth: () => calculateApprovalDialogLayout(
    renderer.width,
    renderer.height,
  ).width,
  getHeight: () => calculateApprovalDialogLayout(
    renderer.width,
    renderer.height,
  ).height,
  onChange: () => refreshApproval(),
});
const approvalView = new ApprovalView(renderer, {
  onDraftChange: (draft) => approvalController.setDraft(draft),
});
const overlayLoadingController = new LoadingCellController({
  onTick: () => {
    if (controller.getState().pendingSessionCommand === 'compact') {
      refreshLive();
    }
    if (noticeOverlay.phase === 'interrupting') refreshNoticeOverlay();
    if (sessionPicker.phase === 'loading' || sessionPicker.phase === 'resuming') {
      refreshSessionPicker();
    }
    if (policyPicker.phase === 'saving') refreshPolicyPicker();
    if (modelPicker.phase === 'loading' || modelPicker.phase === 'selecting') {
      refreshModelPicker();
    }
  },
});
const composerDecorationStyle = createComposerDecorationStyle();
const composer = new TextareaRenderable(renderer, {
  id: 'composer',
  width: '100%',
  height: '100%',
  backgroundColor: RGBA.defaultBackground(),
  focusedBackgroundColor: RGBA.defaultBackground(),
  syntaxStyle: composerDecorationStyle,
  placeholder: COMPOSER_PLACEHOLDER,
  keyBindings: COMPOSER_KEY_BINDINGS,
  onSubmit: () => submitComposerInput(),
  onCursorChange: () => syncComposerInputOverlays(),
  onPaste: (event: PasteEvent) => {
    const result = handleAttachmentPasteEvent(attachments, event);
    attachments = result.attachments;
    if (result.handled) {
      localNotice = result.notice;
      refreshHeader();
      syncComposerInputOverlays();
      syncComposerLayout();
      refreshStatus();
    } else if (result.pendingNotice) {
      pendingComposerNotice = result.pendingNotice;
    }
  },
});
const composerDecorations = new ComposerDecorationController(
  composer,
  composerDecorationStyle,
);
composer.onContentChange = handleComposerContentChange;
installTextareaWorkarounds(composer);
installTextareaWorkarounds(approvalView.input);

root.add(header);
root.add(currentPlan);
root.add(live);
composerFrame.add(composer);
root.add(composerFrame);
root.add(status);
root.add(commandOverlayView.frame);
root.add(fileMentionView.frame);
root.add(sessionPickerView.frame);
root.add(policyPickerView.frame);
root.add(modelPickerView.frame);
root.add(noticeOverlayView.frame);
root.add(approvalView.frame);
renderer.root.add(root);
if (smoke.command || demo.command) {
  composer.setText('/');
  composer.gotoBufferEnd();
}
composer.focus();
syncComposerInputOverlays();

const qaLifecycle = new QaLifecycleDriver(launchOptions, {
  destroySoon: () => {
    setTimeout(() => renderer.destroy(), 50);
  },
  onFrame: (callback) => renderer.once('frame', callback),
  runPolicySelection: () => {
    handlePolicyPickerAction('move-down');
    handlePolicyPickerAction('select');
  },
  setComposerText: (text) => {
    composer.setText(text);
    composer.gotoBufferEnd();
  },
  submitCurrentComposer: () => submitComposerInput(),
  submitInput: (input) => submitComposerInput(input),
});

const unsubscribe = controller.subscribe((state) => {
  liveActivityController.sync(state.session.activeRun);
  syncOverlayLoading();
  if (state.session.sessionId !== focusedSessionId) {
    focusedSessionId = state.session.sessionId;
    composerMode = state.session.kind;
    studioConversationId = null;
  }
  syncApprovalFromSession();
  syncNoticeFromSession();
  syncComposerInputOverlays();
  syncComposerModeUi();
  syncComposerLayout();
  refreshLive();
  if (state.session.sessionId !== 'pending') {
    timeline.renderWelcome(buildWelcomeLines({
      session: state.session,
      width: renderer.width,
      connection: formatConnection(state.connection),
      hostMetadata,
    }));
  }
  if (!terminalHandoffOpen) {
    timeline.render(state.session);
  }
  refreshStatus();
  qaLifecycle.handleState(state);
});
renderer.keyInput.on('keypress', (key) => {
  const approval = approvalController.getState();
  if (key.ctrl && !key.shift && key.name === 'c') {
    key.preventDefault();
    key.stopPropagation();
    handleGlobalInterrupt(approval);
    return;
  }
  if (key.name === 'escape' && approval.phase === 'resolution-sent') {
    key.preventDefault();
    key.stopPropagation();
    if (!approval.interruptSent) {
      requestReviewResolutionInterrupt(approval);
    }
    return;
  }
  const clipboardAction = resolveClipboardAction(key);
  const clipboardEditor = activeClipboardEditor(approval);
  if (clipboardAction && clipboardEditor) {
    const result = applyClipboardAction({
      action: clipboardAction,
      editor: clipboardEditor,
      copy: (text) => renderer.copyToClipboardOSC52(text),
    });
    if (result.handled) {
      key.preventDefault();
      key.stopPropagation();
      localNotice = result.copied
        ? clipboardAction === 'cut' && result.cut
          ? 'cut selection to clipboard'
          : 'copied selection to clipboard'
        : 'terminal clipboard is unavailable';
      syncComposerLayout();
      refreshStatus();
      return;
    }
  }

  syncComposerInputOverlays();
  const owner = currentInteractionOwner(approval);
  switch (owner.type) {
    case 'approval': {
      const action = resolveApprovalKey(approval, key);
      if (action) {
        key.preventDefault();
        key.stopPropagation();
        approvalController.handle(action);
        return;
      }
      if (owner.acceptsTextInput) return;
      key.preventDefault();
      key.stopPropagation();
      return;
    }
    case 'notice': {
      const action = resolveNoticeOverlayKey(noticeOverlay, key);
      key.preventDefault();
      key.stopPropagation();
      if (action === 'close') closeNoticeOverlayUi();
      return;
    }
    case 'policy-picker': {
      const action = resolvePolicyPickerKey(policyPicker, key);
      key.preventDefault();
      key.stopPropagation();
      handlePolicyPickerAction(action);
      return;
    }
    case 'model-picker': {
      const action = resolveModelPickerKey(modelPicker, key);
      key.preventDefault();
      key.stopPropagation();
      handleModelPickerAction(action);
      return;
    }
    case 'command-help': {
      const action = resolveCommandOverlayKey(commandOverlay, key);
      key.preventDefault();
      key.stopPropagation();
      handleCommandOverlayAction(action);
      return;
    }
    case 'session-picker': {
      const action = resolveSessionPickerKey(sessionPicker, key);
      key.preventDefault();
      key.stopPropagation();
      handleSessionPickerAction(action);
      return;
    }
    case 'command-palette': {
      const pickerAction = resolveSessionPickerKey(sessionPicker, key);
      if (pickerAction === 'open') {
        key.preventDefault();
        key.stopPropagation();
        openSessionPicker();
        return;
      }
      const action = resolveCommandOverlayKey(commandOverlay, key);
      if (action) {
        key.preventDefault();
        key.stopPropagation();
        handleCommandOverlayAction(action);
        return;
      }
      break;
    }
    case 'file-mention': {
      const pickerAction = resolveSessionPickerKey(sessionPicker, key);
      if (pickerAction === 'open') {
        key.preventDefault();
        key.stopPropagation();
        openSessionPicker();
        return;
      }
      const action = resolveFileMentionKey(fileMention, key);
      if (action) {
        key.preventDefault();
        key.stopPropagation();
        handleFileMentionAction(action);
        return;
      }
      break;
    }
    case 'composer': {
      const pickerAction = resolveSessionPickerKey(sessionPicker, key);
      if (pickerAction === 'open') {
        key.preventDefault();
        key.stopPropagation();
        openSessionPicker();
        return;
      }
      break;
    }
  }

  const historyDirection = resolveComposerHistoryDirection(
    key,
    composer,
    composerHistory,
  );
  if (historyDirection) {
    key.preventDefault();
    key.stopPropagation();
    applyComposerHistoryNavigation(historyDirection);
    return;
  }
  if (shouldOpenTranscriptPager({
    key,
    composerText: composer.plainText,
    attachmentCount: attachments.length,
  })) {
    key.preventDefault();
    key.stopPropagation();
    openTranscriptPager();
    return;
  }
  if (
    key.name === 'escape'
    && controller.getState().session.activeRun
  ) {
    key.preventDefault();
    key.stopPropagation();
    requestRunInterrupt();
    return;
  }
  releaseStickyComposerNotice();
  if (
    key.name === 'backspace'
    && !key.ctrl
    && !key.meta
    && !key.option
    && composer.plainText.length === 0
    && attachments.length > 0
  ) {
    key.preventDefault();
    attachments = removeLastAttachment(attachments);
    localNotice = attachments.length
      ? `${attachments.length} attachment${attachments.length === 1 ? '' : 's'} remaining`
      : 'attachment removed';
    refreshHeader();
    syncComposerInputOverlays();
    syncComposerLayout();
    refreshStatus();
  }
});
renderer.keyInput.on('paste', (event) => {
  const owner = currentInteractionOwner(
    approvalController.getState(),
  );
  if (interactionOwnerBlocksPaste(owner)) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  releaseStickyComposerNotice();
});
renderer.on('resize', () => {
  syncComposerLayout();
  refreshLive();
  refreshSessionPicker();
  refreshPolicyPicker();
  refreshModelPicker();
  refreshApproval();
  refreshCommandOverlay();
  refreshFileMention();
  refreshNoticeOverlay();
});
renderer.on('destroy', () => {
  liveActivityController.destroy();
  overlayLoadingController.destroy();
  interruptPendingNoticeController.destroy();
  sessionPickerGeneration += 1;
  policyPickerGeneration += 1;
  modelPickerGeneration += 1;
  sessionPicker = closeSessionPicker(sessionPicker);
  policyPicker = closePolicyPicker(policyPicker);
  modelPicker = closeModelPicker(modelPicker);
  commandOverlay = closeCommandOverlay();
  fileMention = createFileMentionState();
  noticeOverlay = closeNoticeOverlay();
  approvalController.destroy();
  unsubscribe();
  controller.stop();
  timeline.destroy();
  composerDecorations.destroy();
  composerDecorationStyle.destroy();
});

syncComposerLayout();
syncComposerModeUi();
controller.start();
qaLifecycle.installInitialFrameBehavior();

function syncComposerLayout() {
  refreshCurrentPlan();
  const layout = calculateComposerLayout(
    composer.plainText,
    composer.virtualLineCount,
    {
      commandPalette: commandOverlay.phase === 'palette',
      persistentHeader: attachments.length > 0,
      planHeight: currentPlan.height,
    },
  );
  composerFrame.border = commandOverlay.phase === 'palette'
    ? ['top']
    : true;
  composerFrame.height = layout.frameHeight;
  header.height = layout.headerHeight;
  live.height = layout.liveHeight;
  status.height = layout.statusHeight;
  renderer.footerHeight = approvalController.getState().phase === 'closed'
    ? layout.footerHeight
    : APPROVAL_FOOTER_ROWS;
}

function refreshCurrentPlan() {
  const overlayOpen = commandOverlay.phase !== 'closed'
    || fileMention.phase !== 'closed'
    || sessionPicker.phase !== 'closed'
    || policyPicker.phase !== 'closed'
    || modelPicker.phase !== 'closed'
    || noticeOverlay.phase !== 'closed'
    || approvalController.getState().phase !== 'closed';
  const panel = buildCurrentPlanPanel(
    controller.getState().session.currentPlan,
    {
      width: renderer.width,
      terminalHeight: renderer.height,
      overlayOpen,
    },
  );
  currentPlan.content = panel.content;
  currentPlan.height = panel.height;
}

function refreshHeader() {
  header.content = attachments.length
    ? truncateTerminalLine(formatAttachmentStrip(attachments), renderer.width)
    : '';
}

function syncComposerModeUi() {
  composer.placeholder = formatComposerPlaceholder(
    controller.getState().session,
    composerMode,
  );
  refreshHeader();
}

function refreshLive() {
  const state = controller.getState();
  if (state.pendingSessionCommand === 'compact') {
    live.content = buildLoadingCellLine(
      'compacting older context · request sent',
      overlayLoadingController.frame,
      { prefix: 'live · ' },
    );
    return;
  }
  const session = state.session;
  const activity = formatLiveActivity(
    session,
    liveActivityController.frame,
    Math.max(1, renderer.width - 7),
    liveActivityController.longWaiting,
    Date.now(),
  );
  live.content = isLiveActivityPulseActive(
    session,
    liveActivityController.frame,
  )
    ? buildLoadingCellLine(activity, liveActivityController.frame, {
        prefix: 'live · ',
      })
    : truncateTerminalLine(`live · ${activity}`, renderer.width);
}

function refreshStatus() {
  status.content = formatStatusLines(
    controller.getState(),
    renderer.width,
    localNotice,
  ).join('\n');
}

function syncComposerInputOverlays() {
  commandOverlay = syncCommandPalette(commandOverlay, {
    text: composer.plainText,
    cursorOffset: composer.cursorOffset,
    enabled: attachments.length === 0
      && !terminalHandoffOpen
      && sessionPicker.phase === 'closed'
      && policyPicker.phase === 'closed'
      && modelPicker.phase === 'closed'
      && noticeOverlay.phase === 'closed'
      && approvalController.getState().phase === 'closed',
  });
  refreshCommandOverlay();

  const currentInput = readComposerTextInput(composer);
  if (
    dismissedFileMention
    && (
      dismissedFileMention.text !== currentInput.text
      || dismissedFileMention.cursorOffset !== currentInput.cursorOffset
    )
  ) {
    dismissedFileMention = null;
  }
  fileMention = syncFileMention(
    fileMention,
    currentInput,
    controller.getState().session.runtime?.cwd ?? process.cwd(),
    composerMode === 'chat'
      && commandOverlay.phase === 'closed'
      && !dismissedFileMention
      && !terminalHandoffOpen
      && sessionPicker.phase === 'closed'
      && policyPicker.phase === 'closed'
      && modelPicker.phase === 'closed'
      && noticeOverlay.phase === 'closed'
      && approvalController.getState().phase === 'closed',
  );
  refreshFileMention();
}

function currentInteractionOwner(
  approval: ApprovalState,
): InteractionOwner {
  return resolveInteractionOwner({
    approval: {
      open: approval.phase !== 'closed',
      acceptsTextInput: approvalAcceptsTextInput(approval),
    },
    noticeOpen: noticeOverlay.phase !== 'closed',
    policyPickerOpen: policyPicker.phase !== 'closed',
    modelPickerOpen: modelPicker.phase !== 'closed',
    commandHelpOpen: commandOverlay.phase === 'help',
    sessionPickerOpen: sessionPicker.phase !== 'closed',
    commandPaletteOpen: commandOverlay.phase === 'palette',
    fileMentionOpen: fileMention.phase === 'open',
  });
}

function refreshCommandOverlay() {
  syncComposerCursorForCommandOverlay(composer, commandOverlay);
  commandOverlayView.render(commandOverlay, renderer.width);
  syncComposerLayout();
}

function refreshFileMention() {
  fileMentionView.render(fileMention, renderer.width);
}

function closeFileMentionOverlay() {
  fileMention = createFileMentionState();
  refreshFileMention();
}

function handleFileMentionAction(action: FileMentionAction) {
  if (!action) return;
  if (action === 'previous' || action === 'next') {
    fileMention = moveFileMentionSelection(
      fileMention,
      action === 'previous' ? -1 : 1,
    );
    refreshFileMention();
    return;
  }
  if (action === 'dismiss') {
    dismissedFileMention = readComposerTextInput(composer);
    fileMention = createFileMentionState();
    refreshFileMention();
    return;
  }
  const completion = completeFileMention(
    readComposerTextInput(composer),
    fileMention,
  );
  if (!completion) return;
  dismissedFileMention = null;
  composer.replaceText(completion.text);
  composerDecorations.addCompletedFileMention(completion);
  placeComposerCursorAtTextOffset(
    composer,
    completion.text,
    completion.cursorOffset,
  );
  syncComposerInputOverlays();
  syncComposerLayout();
}

function handleComposerContentChange() {
  composerDecorations.scheduleRefresh();
  const selectedHistoryText = composerHistory.selectedIndex === null
    ? undefined
    : composerHistory.entries[composerHistory.selectedIndex];
  if (selectedHistoryText !== composer.plainText) {
    composerHistory = resetComposerHistoryNavigation(composerHistory);
  }
  if (!composerNoticeSticky) {
    localNotice = pendingComposerNotice;
  }
  pendingComposerNotice = null;
  syncComposerInputOverlays();
  syncComposerLayout();
  refreshStatus();
}

function syncNoticeFromSession() {
  const previous = noticeOverlay;
  noticeOverlay = syncNoticeOverlay(
    noticeOverlay,
    controller.getState(),
  );
  interruptPendingNoticeController.sync(noticeOverlay);
  if (noticeOverlay.phase !== 'closed') {
    closeFileMentionOverlay();
    if (commandOverlay.phase !== 'closed') {
      commandOverlay = closeCommandOverlay();
      refreshCommandOverlay();
    }
    if (sessionPicker.phase !== 'closed') {
      sessionPickerGeneration += 1;
      sessionPicker = closeSessionPicker(sessionPicker);
      refreshSessionPicker();
    }
    if (policyPicker.phase !== 'closed') {
      policyPickerGeneration += 1;
      policyPicker = closePolicyPicker(policyPicker);
      refreshPolicyPicker();
    }
    if (modelPicker.phase !== 'closed') {
      modelPickerGeneration += 1;
      controller.cancelModelProfileList();
      modelPicker = closeModelPicker(modelPicker);
      refreshModelPicker();
    }
    composer.blur();
  } else if (
    shouldRestoreComposerAfterNoticeSync(previous, noticeOverlay)
    && !terminalHandoffOpen
    && approvalController.getState().phase === 'closed'
    && sessionPicker.phase === 'closed'
    && policyPicker.phase === 'closed'
    && modelPicker.phase === 'closed'
    && commandOverlay.phase !== 'help'
  ) {
    if (
      previous.phase === 'interrupting'
      && localNotice?.startsWith('interrupt requested')
    ) {
      localNotice = null;
    }
    composer.focus();
    syncComposerInputOverlays();
  }
  refreshNoticeOverlay();
}

function closeNoticeOverlayUi() {
  noticeOverlay = closeNoticeOverlay(noticeOverlay);
  refreshNoticeOverlay();
  if (
    !terminalHandoffOpen
    && approvalController.getState().phase === 'closed'
    && policyPicker.phase === 'closed'
    && modelPicker.phase === 'closed'
  ) {
    composer.focus();
    syncComposerInputOverlays();
  }
}

function showErrorNotice(message: string) {
  noticeOverlay = openErrorNotice(message);
  closeFileMentionOverlay();
  composer.blur();
  refreshNoticeOverlay();
}

function refreshNoticeOverlay() {
  syncOverlayLoading();
  noticeOverlayView.render(
    noticeOverlay,
    renderer.width,
    overlayLoadingController.frame,
  );
}

function handleGlobalInterrupt(
  approval: ReturnType<ApprovalController['getState']>,
) {
  const action = resolveGlobalInterruptAction({
    approval,
    activeRun: controller.getState().session.activeRun,
  });
  if (action === 'cancel-review') {
    approvalController.handle('cancel');
    return;
  }
  if (action === 'interrupt-run') {
    if (approval.phase === 'resolution-sent') {
      requestReviewResolutionInterrupt(approval);
    } else {
      requestRunInterrupt();
    }
    return;
  }
  renderer.destroy();
}

function requestReviewResolutionInterrupt(
  approval: Exclude<
    ReturnType<ApprovalController['getState']>,
    { phase: 'closed' }
  >,
) {
  const result = controller.interruptResolvedReview({
    interruptId: approval.pendingInterrupt.interruptId,
  });
  if (result.ok) {
    approvalController.markInterruptSent();
    localNotice = 'interrupt requested · Ctrl+C again to exit';
  } else {
    approvalController.noteResolutionWait(
      reviewResolutionInterruptFailureText(result.reason),
    );
  }
  refreshApproval();
  refreshLive();
  refreshStatus();
}

function requestRunInterrupt() {
  const result = controller.interruptRun();
  if (result.ok) {
    localNotice = 'interrupt requested · Ctrl+C again to exit';
  } else if (result.reason === 'already-interrupting') {
    renderer.destroy();
    return;
  } else {
    showErrorNotice(interruptFailureText(result.reason));
  }
  refreshLive();
  refreshStatus();
}

function syncApprovalFromSession() {
  const previous = approvalController.getState();
  approvalController.sync(
    controller.getState().session.pendingInterrupt,
    controller.getState().connection,
    controller.getState().session.activeRun !== null,
  );
  const approval = approvalController.getState();
  if (approval.phase !== 'closed') {
    closeFileMentionOverlay();
    if (commandOverlay.phase !== 'closed') {
      commandOverlay = closeCommandOverlay();
      refreshCommandOverlay();
    }
    if (sessionPicker.phase !== 'closed') {
      sessionPickerGeneration += 1;
      sessionPicker = closeSessionPicker(sessionPicker);
      refreshSessionPicker();
    }
    if (policyPicker.phase !== 'closed') {
      policyPickerGeneration += 1;
      policyPicker = closePolicyPicker(policyPicker);
      refreshPolicyPicker();
    }
    if (modelPicker.phase !== 'closed') {
      modelPickerGeneration += 1;
      controller.cancelModelProfileList();
      modelPicker = closeModelPicker(modelPicker);
      refreshModelPicker();
    }
    composer.blur();
  } else if (
    previous.phase !== 'closed'
    && !terminalHandoffOpen
    && sessionPicker.phase === 'closed'
    && policyPicker.phase === 'closed'
    && modelPicker.phase === 'closed'
    && noticeOverlay.phase === 'closed'
  ) {
    composer.focus();
    syncComposerInputOverlays();
  }
  refreshApproval();
}

function refreshApproval() {
  const approval = approvalController.getState();
  syncComposerLayout();
  approvalView.render(approval, renderer.width, renderer.height);
  if (approval.phase === 'closed') return;
  composer.blur();
  if (
    approvalAcceptsTextInput(approval)
    && !approvalView.input.focused
  ) {
    approvalView.focusInput();
  }
}

function openSessionPicker() {
  if (terminalHandoffOpen || sessionPicker.phase !== 'closed') return;
  modelPickerGeneration += 1;
  controller.cancelModelProfileList();
  modelPicker = closeModelPicker(modelPicker);
  commandOverlay = closeCommandOverlay();
  closeFileMentionOverlay();
  refreshCommandOverlay();
  refreshModelPicker();
  const generation = sessionPickerGeneration + 1;
  sessionPickerGeneration = generation;
  sessionPicker = beginSessionPickerLoad(sessionPicker);
  composer.blur();
  refreshSessionPicker();

  const request = sessionListRequest ?? controller.listSessions();
  if (!sessionListRequest) {
    sessionListRequest = request;
    void request.then(
      () => {
        if (sessionListRequest === request) sessionListRequest = null;
      },
      () => {
        if (sessionListRequest === request) sessionListRequest = null;
      },
    );
  }
  void request.then((sessions) => {
    if (
      sessionPickerGeneration !== generation
      || sessionPicker.phase !== 'loading'
    ) {
      return;
    }
    sessionPicker = loadSessionPickerSessions(sessions);
    refreshSessionPicker();
  }).catch((error: unknown) => {
    if (
      sessionPickerGeneration !== generation
      || sessionPicker.phase !== 'loading'
    ) {
      return;
    }
    sessionPicker = failSessionPicker(sessionPicker, errorMessage(error));
    refreshSessionPicker();
  });
}

function handleSessionPickerAction(action: SessionPickerAction) {
  if (action === 'close') {
    closeSessionPickerUi();
    return;
  }
  if (action === 'select') {
    resumeSelectedSession();
    return;
  }
  const next = applySessionPickerAction(sessionPicker, action);
  if (next !== sessionPicker) {
    sessionPicker = next;
    refreshSessionPicker();
  }
}

function resumeSelectedSession() {
  const selected = selectedSession(sessionPicker);
  if (sessionPicker.phase !== 'ready') return;
  if (!selected) {
    sessionPicker = failSessionPicker(sessionPicker, 'no session is selected');
    refreshSessionPicker();
    return;
  }
  const generation = sessionPickerGeneration + 1;
  sessionPickerGeneration = generation;
  sessionPicker = beginSessionResume(sessionPicker);
  refreshSessionPicker();
  void controller.resumeSession(selected.id).then(({ session }) => {
    if (
      sessionPickerGeneration !== generation
      || sessionPicker.phase !== 'resuming'
    ) {
      return;
    }
    attachments = [];
    clearComposerPreservingNotice();
    localNotice = `resumed: ${session.title}`;
    closeSessionPickerUi();
    refreshHeader();
    syncComposerLayout();
    refreshStatus();
  }).catch((error: unknown) => {
    if (
      sessionPickerGeneration !== generation
      || sessionPicker.phase !== 'resuming'
    ) {
      return;
    }
    sessionPicker = failSessionPicker(sessionPicker, errorMessage(error));
    refreshSessionPicker();
  });
}

function closeSessionPickerUi() {
  sessionPickerGeneration += 1;
  sessionPicker = closeSessionPicker(sessionPicker);
  refreshSessionPicker();
  if (
    !terminalHandoffOpen
    && modelPicker.phase === 'closed'
    && noticeOverlay.phase === 'closed'
  ) {
    composer.focus();
    syncComposerInputOverlays();
  }
}

function refreshSessionPicker() {
  syncOverlayLoading();
  sessionPickerView.render(
    sessionPicker,
    renderer.width,
    overlayLoadingController.frame,
  );
}

function openPolicyPickerUi() {
  if (terminalHandoffOpen || policyPicker.phase !== 'closed') return;
  const state = controller.getState();
  const currentMode = state.session.runtime?.globalReviewPolicyMode;
  if (state.connection !== 'ready') {
    showErrorNotice('local-agent is not connected');
    return;
  }
  if (state.session.activeRun) {
    showErrorNotice('wait for the current response to finish');
    return;
  }
  if (!currentMode) {
    showErrorNotice('local-agent does not expose review policy state; upgrade the host');
    return;
  }
  commandOverlay = closeCommandOverlay();
  closeFileMentionOverlay();
  sessionPickerGeneration += 1;
  sessionPicker = closeSessionPicker(sessionPicker);
  modelPickerGeneration += 1;
  controller.cancelModelProfileList();
  modelPicker = closeModelPicker(modelPicker);
  policyPickerGeneration += 1;
  policyPicker = openPolicyPicker(
    policyPicker,
    currentMode,
    state.session.runtime?.autoAuthorizationSafetyLevel ?? 'strict',
  );
  composer.blur();
  refreshCommandOverlay();
  refreshSessionPicker();
  refreshModelPicker();
  refreshPolicyPicker();
}

function handlePolicyPickerAction(action: PolicyPickerAction) {
  if (action === 'close') {
    closePolicyPickerUi();
    return;
  }
  if (action === 'move-up' || action === 'move-down') {
    policyPicker = movePolicySelection(
      policyPicker,
      action === 'move-up' ? -1 : 1,
    );
    refreshPolicyPicker();
    return;
  }
  if (action === 'select') {
    saveSelectedPolicy();
  }
}

function saveSelectedPolicy() {
  const option = selectedPolicy(policyPicker);
  if (!option || policyPicker.phase === 'saving') return;
  const generation = policyPickerGeneration + 1;
  policyPickerGeneration = generation;
  policyPicker = beginPolicySave(policyPicker);
  refreshPolicyPicker();
  const autoAuthorizationSafetyLevel = option.autoAuthorizationSafetyLevel
    ?? policyPicker.currentAutoAuthorizationSafetyLevel;
  void controller.updateGlobalReviewPolicy(
    option.mode,
    autoAuthorizationSafetyLevel,
  ).then((result) => {
    if (
      policyPickerGeneration !== generation
      || policyPicker.phase !== 'saving'
    ) {
      return;
    }
    policyPicker = closePolicyPicker({
      ...policyPicker,
      currentMode: result.globalReviewPolicyMode,
      currentAutoAuthorizationSafetyLevel: result.autoAuthorizationSafetyLevel,
    });
    localNotice = `review policy: ${option.label}`;
    refreshPolicyPicker();
    refreshStatus();
    if (!terminalHandoffOpen) {
      composer.focus();
      syncComposerInputOverlays();
    }
  }).catch((error: unknown) => {
    if (
      policyPickerGeneration !== generation
      || policyPicker.phase !== 'saving'
    ) {
      return;
    }
    policyPicker = failPolicySave(policyPicker, errorMessage(error));
    refreshPolicyPicker();
  });
}

function closePolicyPickerUi() {
  policyPickerGeneration += 1;
  policyPicker = closePolicyPicker(policyPicker);
  refreshPolicyPicker();
  if (
    !terminalHandoffOpen
    && sessionPicker.phase === 'closed'
    && modelPicker.phase === 'closed'
    && noticeOverlay.phase === 'closed'
    && approvalController.getState().phase === 'closed'
  ) {
    composer.focus();
    syncComposerInputOverlays();
  }
}

function refreshPolicyPicker() {
  syncOverlayLoading();
  policyPickerView.render(
    policyPicker,
    renderer.width,
    overlayLoadingController.frame,
  );
}

function openModelPickerUi() {
  if (terminalHandoffOpen || modelPicker.phase !== 'closed') return;
  const state = controller.getState();
  if (state.connection !== 'ready') {
    showErrorNotice('local-agent is not connected');
    return;
  }
  if (state.session.activeRun) {
    showErrorNotice('wait for the current response to finish');
    return;
  }
  commandOverlay = closeCommandOverlay();
  closeFileMentionOverlay();
  sessionPickerGeneration += 1;
  sessionPicker = closeSessionPicker(sessionPicker);
  policyPickerGeneration += 1;
  policyPicker = closePolicyPicker(policyPicker);
  const generation = modelPickerGeneration + 1;
  modelPickerGeneration = generation;
  modelPicker = beginModelPickerLoad(
    modelPicker,
    state.session.runtime?.modelProfileId,
  );
  composer.blur();
  refreshCommandOverlay();
  refreshSessionPicker();
  refreshPolicyPicker();
  refreshModelPicker();

  void controller.listModelProfiles().then((result) => {
    if (
      modelPickerGeneration !== generation
      || modelPicker.phase !== 'loading'
    ) {
      return;
    }
    modelPicker = loadModelPickerProfiles(result);
    refreshModelPicker();
  }).catch((error: unknown) => {
    if (
      modelPickerGeneration !== generation
      || modelPicker.phase !== 'loading'
    ) {
      return;
    }
    modelPicker = failModelPicker(modelPicker, errorMessage(error));
    refreshModelPicker();
  });
}

function handleModelPickerAction(action: ModelPickerAction) {
  if (action === 'close') {
    closeModelPickerUi();
    return;
  }
  if (action === 'move-up' || action === 'move-down') {
    modelPicker = moveModelPickerSelection(
      modelPicker,
      action === 'move-up' ? -1 : 1,
    );
    refreshModelPicker();
    return;
  }
  if (action === 'select') {
    selectCurrentModelProfile();
  }
}

function selectCurrentModelProfile() {
  const profile = selectedModelProfile(modelPicker);
  if (!profile || modelPicker.phase === 'loading' || modelPicker.phase === 'selecting') {
    return;
  }
  const next = beginModelSelection(modelPicker);
  if (next.phase === 'error') {
    modelPicker = next;
    refreshModelPicker();
    return;
  }
  if (profile.id === modelPicker.selectedProfileId) {
    closeModelPickerUi();
    return;
  }
  const generation = modelPickerGeneration + 1;
  modelPickerGeneration = generation;
  modelPicker = next;
  refreshModelPicker();
  void controller.selectModelProfile(
    profile.id,
    modelPicker.sessionId,
  ).then(() => {
    if (
      modelPickerGeneration !== generation
      || modelPicker.phase !== 'selecting'
    ) {
      return;
    }
    modelPicker = closeModelPicker({
      ...modelPicker,
      selectedProfileId: profile.id,
    });
    localNotice = `session model: ${profile.label}`;
    refreshModelPicker();
    refreshHeader();
    refreshStatus();
    if (!terminalHandoffOpen) {
      composer.focus();
      syncComposerInputOverlays();
    }
  }).catch((error: unknown) => {
    if (
      modelPickerGeneration !== generation
      || modelPicker.phase !== 'selecting'
    ) {
      return;
    }
    modelPicker = failModelPicker(modelPicker, errorMessage(error));
    refreshModelPicker();
  });
}

function closeModelPickerUi() {
  if (modelPicker.phase === 'selecting') return;
  modelPickerGeneration += 1;
  if (modelPicker.phase === 'loading') {
    controller.cancelModelProfileList();
  }
  modelPicker = closeModelPicker(modelPicker);
  refreshModelPicker();
  if (
    !terminalHandoffOpen
    && sessionPicker.phase === 'closed'
    && policyPicker.phase === 'closed'
    && modelPicker.phase === 'closed'
    && noticeOverlay.phase === 'closed'
    && approvalController.getState().phase === 'closed'
  ) {
    composer.focus();
    syncComposerInputOverlays();
  }
}

function refreshModelPicker() {
  syncOverlayLoading();
  modelPickerView.render(
    modelPicker,
    renderer.width,
    overlayLoadingController.frame,
  );
}

function syncOverlayLoading() {
  overlayLoadingController.sync(
    controller.getState().pendingSessionCommand === 'compact'
      || noticeOverlay.phase === 'interrupting'
      || sessionPicker.phase === 'loading'
      || sessionPicker.phase === 'resuming'
      || policyPicker.phase === 'saving'
      || modelPicker.phase === 'loading'
      || modelPicker.phase === 'selecting',
  );
}

function handleCommandOverlayAction(action: CommandOverlayAction) {
  if (!action) return;
  if (action === 'previous' || action === 'next') {
    commandOverlay = moveCommandSelection(
      commandOverlay,
      action === 'previous' ? -1 : 1,
    );
    refreshCommandOverlay();
    return;
  }
  if (action === 'page-up' || action === 'page-down') {
    commandOverlay = pageCommandHelp(
      commandOverlay,
      action === 'page-up' ? -1 : 1,
    );
    refreshCommandOverlay();
    return;
  }
  if (action === 'complete') {
    const completion = commandCompletion(commandOverlay);
    if (completion) {
      composer.replaceText(completion);
      composer.gotoBufferEnd();
    }
    return;
  }
  if (action === 'submit') {
    const submission = commandCompletion(commandOverlay) ?? composer.plainText;
    submitComposerInput(submission);
    return;
  }
  if (commandOverlay.phase === 'palette') {
    composer.clear();
  }
  closeCommandOverlayUi();
}

function openCommandHelpUi() {
  if (terminalHandoffOpen) return;
  commandOverlay = openCommandHelp();
  closeFileMentionOverlay();
  composer.blur();
  refreshCommandOverlay();
}

function closeCommandOverlayUi() {
  commandOverlay = closeCommandOverlay();
  refreshCommandOverlay();
  if (
    !terminalHandoffOpen
    && sessionPicker.phase === 'closed'
    && policyPicker.phase === 'closed'
    && noticeOverlay.phase === 'closed'
    && approvalController.getState().phase === 'closed'
  ) {
    composer.focus();
  }
}

function submitComposerInput(input = composer.plainText) {
  const intent = resolveComposerIntent({
    text: input,
    attachmentCount: attachments.length,
    mode: composerMode,
  });

  switch (intent.type) {
    case 'none':
      return;
    case 'notice':
      clearComposerPreservingNotice();
      localNotice = intent.message;
      refreshStatus();
      return;
    case 'quit':
      renderer.destroy();
      return;
    case 'open-help':
      composer.clear();
      localNotice = null;
      openCommandHelpUi();
      return;
    case 'continue-delegation': {
      enterChatMode(false);
      const result = controller.continueActiveDelegation(intent.guidance);
      if (result.ok) {
        composerHistory = recordComposerHistoryEntry(
          composerHistory,
          intent.guidance,
        );
        composer.clear();
        localNotice = null;
        refreshHeader();
        syncComposerLayout();
      } else {
        localNotice = submitFailureText(result.reason);
        refreshStatus();
      }
      return;
    }
    case 'refresh-session': {
      clearComposerPreservingNotice();
      const result = controller.refreshSession();
      localNotice = result.ok
        ? 'refreshing session snapshot…'
        : submitFailureText(result.reason);
      refreshStatus();
      return;
    }
    case 'compact-session':
      clearComposerPreservingNotice();
      localNotice = 'compaction request sent · summarizing older context…';
      refreshStatus();
      void controller.compactSession().then(({ compacted }) => {
        localNotice = compacted
          ? 'older context compacted'
          : 'nothing older to compact';
        refreshHeader();
        refreshStatus();
      }).catch((error) => {
        showErrorNotice(errorMessage(error));
      });
      return;
    case 'open-resume':
      composer.clear();
      localNotice = null;
      openSessionPicker();
      return;
    case 'open-model':
      composer.clear();
      localNotice = null;
      enterChatMode(false);
      openModelPickerUi();
      return;
    case 'open-policy':
      composer.clear();
      localNotice = null;
      openPolicyPickerUi();
      return;
    case 'open-transcript':
      openTranscriptPager();
      return;
    case 'export-transcript':
      exportCurrentTranscript(intent.path);
      return;
    case 'open-editor':
      openExternalEditor(intent.text);
      return;
    case 'enter-chat':
      enterChatMode();
      return;
    case 'enter-studio':
      enterStudioMode();
      return;
    case 'submit-studio':
      if (intent.enterMode) {
        enterStudioMode(false);
      }
      submitStudioInput(intent.text);
      return;
    case 'start-new-session':
      clearComposerPreservingNotice();
      localNotice = 'creating new session…';
      refreshStatus();
      void controller.startNewSession().then(() => {
        attachments = [];
        enterChatMode(false);
        localNotice = 'new chat session';
        refreshHeader();
        syncComposerLayout();
        refreshStatus();
      }).catch((error) => {
        showErrorNotice(errorMessage(error));
      });
      return;
    case 'submit-chat': {
      const result = controller.submitChat(intent.text, attachments);
      if (result.ok) {
        composerHistory = recordComposerHistoryEntry(
          composerHistory,
          intent.text,
        );
        attachments = [];
        composer.clear();
        localNotice = null;
        refreshHeader();
        syncComposerLayout();
      } else {
        localNotice = submitFailureText(result.reason);
        refreshStatus();
      }
    }
  }
}

function enterStudioMode(clearComposer = true) {
  if (clearComposer) composer.clear();
  composerMode = 'studio';
  studioConversationId ??= crypto.randomUUID();
  localNotice = 'studio mode · /chat to return';
  syncComposerModeUi();
  syncComposerInputOverlays();
  syncComposerLayout();
  refreshStatus();
}

function enterChatMode(clearComposer = true) {
  if (clearComposer) composer.clear();
  composerMode = 'chat';
  studioConversationId = null;
  localNotice = 'chat mode';
  syncComposerModeUi();
  syncComposerInputOverlays();
  syncComposerLayout();
  refreshStatus();
}

function submitStudioInput(input: string) {
  if (attachments.length > 0) {
    localNotice = 'Studio attachments are not supported yet · remove them or use /chat';
    refreshStatus();
    return;
  }
  const conversationId = studioConversationId ?? crypto.randomUUID();
  studioConversationId = conversationId;
  const result = controller.submitStudio(input, conversationId);
  if (result.ok) {
    composer.clear();
    localNotice = null;
    syncComposerLayout();
    refreshHeader();
  } else {
    localNotice = submitFailureText(result.reason);
    refreshStatus();
  }
}

function exportCurrentTranscript(requestedPath?: string) {
  const session = controller.getState().session;
  clearComposerPreservingNotice();
  if (session.sessionId === 'pending') {
    localNotice = 'no session is available to export';
    refreshStatus();
    return;
  }
  localNotice = 'exporting transcript…';
  refreshStatus();
  void exportSessionTranscript({
    session,
    requestedPath,
  }).then(({ filePath }) => {
    localNotice = `exported: ${filePath}`;
    refreshStatus();
  }).catch((error: unknown) => {
    showErrorNotice(`transcript export failed: ${errorMessage(error)}`);
  });
}

function openExternalEditor(initialText: string) {
  if (terminalHandoffOpen) return;
  if (controller.getState().session.activeRun) {
    clearComposerPreservingNotice();
    localNotice = 'wait for the current response before opening an editor';
    refreshStatus();
    return;
  }

  clearComposerPreservingNotice();
  commandOverlay = closeCommandOverlay();
  refreshCommandOverlay();
  terminalHandoffOpen = true;
  composer.blur();
  localNotice = 'external editor active';
  refreshStatus();

  const operation = smoke.edit
    ? async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return `${initialText}\nedited in external editor\n`;
      }
    : () => editTextWithExternalEditor({
        initialText,
        cwd: controller.getState().session.runtime?.cwd ?? process.cwd(),
      });

  void withRendererSuspended(renderer, operation).then((text) => {
    const value = text
      .replace(/\r\n/g, '\n')
      .replace(/\n$/, '');
    if (value) {
      composer.replaceText(value);
      composer.gotoBufferEnd();
      localNotice = 'external editor draft loaded';
    } else {
      composer.clear();
      localNotice = 'external editor returned an empty draft';
    }
  }).catch((error: unknown) => {
    localNotice = `external editor failed: ${errorMessage(error)}`;
  }).finally(() => {
    terminalHandoffOpen = false;
    reconcileTimelineAfterHandoff();
    syncComposerLayout();
    refreshHeader();
    refreshLive();
    refreshStatus();
    if (
      sessionPicker.phase === 'closed'
      && policyPicker.phase === 'closed'
      && modelPicker.phase === 'closed'
      && noticeOverlay.phase === 'closed'
      && approvalController.getState().phase === 'closed'
    ) {
      composer.focus();
      syncComposerInputOverlays();
    }
    if (smoke.edit) {
      setTimeout(() => renderer.destroy(), 50);
    }
  });
}

function openTranscriptPager() {
  if (terminalHandoffOpen) return;
  const session = controller.getState().session;
  clearComposerPreservingNotice();
  if (session.sessionId === 'pending') {
    localNotice = 'no session is available to browse';
    refreshStatus();
    return;
  }
  commandOverlay = closeCommandOverlay();
  refreshCommandOverlay();
  terminalHandoffOpen = true;
  composer.blur();
  localNotice = 'transcript pager active';
  refreshStatus();

  const operation = () => pageSessionTranscript({
    session,
    cwd: process.cwd(),
    ...(smoke.transcript
      ? { env: { ...process.env, PAGER: 'cat' } }
      : {}),
  });
  void withRendererSuspended(renderer, operation).then(() => {
    localNotice = 'transcript closed';
  }).catch((error: unknown) => {
    localNotice = `transcript pager failed: ${errorMessage(error)}`;
  }).finally(() => {
    terminalHandoffOpen = false;
    reconcileTimelineAfterHandoff();
    syncComposerLayout();
    refreshHeader();
    refreshLive();
    refreshStatus();
    if (
      sessionPicker.phase === 'closed'
      && policyPicker.phase === 'closed'
      && modelPicker.phase === 'closed'
      && noticeOverlay.phase === 'closed'
      && approvalController.getState().phase === 'closed'
    ) {
      composer.focus();
      syncComposerInputOverlays();
    }
    if (smoke.transcript) {
      setTimeout(() => renderer.destroy(), 50);
    }
  });
}

function reconcileTimelineAfterHandoff() {
  try {
    timeline.render(controller.getState().session);
  } catch (error) {
    localNotice = `timeline refresh failed: ${errorMessage(error)}`;
  }
}

function activeClipboardEditor(
  approval: ReturnType<ApprovalController['getState']>,
): SelectableEditor | null {
  if (approvalAcceptsTextInput(approval)) {
    return approvalView.input;
  }
  if (
    approval.phase === 'closed'
    && noticeOverlay.phase === 'closed'
    && policyPicker.phase === 'closed'
    && modelPicker.phase === 'closed'
    && sessionPicker.phase === 'closed'
    && commandOverlay.phase !== 'help'
    && !terminalHandoffOpen
  ) {
    return composer;
  }
  return null;
}

function applyComposerHistoryNavigation(
  direction: 'previous' | 'next',
) {
  const result = navigateComposerHistory(
    composerHistory,
    composer.plainText,
    direction,
  );
  composerHistory = result.history;
  composer.setText(result.value);
  composer.gotoBufferEnd();
  syncComposerInputOverlays();
  syncComposerLayout();
}

function clearComposerPreservingNotice() {
  composerNoticeSticky = true;
  composer.clear();
}

function releaseStickyComposerNotice() {
  if (!composerNoticeSticky) return;
  composerNoticeSticky = false;
  localNotice = null;
  refreshStatus();
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function submitFailureText(
  reason:
    | 'not-ready'
    | 'busy'
    | 'empty'
    | 'send-failed',
) {
  switch (reason) {
    case 'not-ready':
      return 'local-agent is not connected';
    case 'busy':
      return 'wait for the current response to finish';
    case 'empty':
      return 'message is empty';
    case 'send-failed':
      return 'message could not be sent';
  }
}

function interruptFailureText(
  reason: 'not-ready' | 'idle' | 'review-active' | 'send-failed',
) {
  switch (reason) {
    case 'not-ready':
      return 'local-agent is not connected';
    case 'idle':
      return 'no active response to interrupt';
    case 'review-active':
      return 'close the active review before interrupting';
    case 'send-failed':
      return 'interrupt request could not be sent';
  }
}

function reviewResolutionInterruptFailureText(
  reason: 'not-ready' | 'closed' | 'stale' | 'send-failed',
) {
  switch (reason) {
    case 'not-ready':
      return 'Connection changed; waiting for authoritative review state…';
    case 'closed':
      return 'Review closed; waiting for the refreshed run state…';
    case 'stale':
      return 'Review changed; waiting for the refreshed review state…';
    case 'send-failed':
      return 'Interrupt could not be sent; press Esc to retry interruption.';
  }
}
