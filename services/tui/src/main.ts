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
import { parseTuiCommand } from './commands/commandRegistry';
import { createDemoConnectionFactory } from './demo/demoConnection';
import { editTextWithExternalEditor } from './editor/externalEditor';
import {
  applyClipboardAction,
  resolveClipboardAction,
  type SelectableEditor,
} from './input/composerClipboard';
import { syncComposerCursorForCommandOverlay } from './input/composerCursor';
import {
  createComposerHistoryState,
  navigateComposerHistory,
  recordComposerHistoryEntry,
  resetComposerHistoryNavigation,
  resolveComposerHistoryDirection,
} from './input/composerHistory';
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
import { shouldOpenTranscriptPager } from './input/transcriptShortcut';
import { TuiSessionController } from './session/sessionController';
import {
  approvalAcceptsTextInput,
  resolveApprovalKey,
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
  openErrorNotice,
  resolveNoticeOverlayKey,
  syncNoticeOverlay,
} from './overlays/noticeOverlayModel';
import { NoticeOverlayView } from './overlays/noticeOverlayView';
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
import { calculateComposerLayout } from './spike/composerLayout';
import { installSingleGraphemeBackspaceWorkaround } from './spike/textareaWorkarounds';
import {
  formatConnection,
  formatHeader,
  formatStatusLines,
} from './status/statusModel';
import { formatLiveSession } from './timeline/timelineModel';
import { TimelineScrollback } from './timeline/timelineScrollback';
import { truncateTerminalLine } from './text/terminalText';
import { withRendererSuspended } from './terminal/rendererLifecycle';
import { exportSessionTranscript } from './transcript/transcriptExport';
import { pageSessionTranscript } from './transcript/transcriptPager';
import { buildWelcomeLines } from './welcome/welcomeModel';

const smokeReview = process.argv.includes('--smoke-review');
const demoReview = process.argv.includes('--demo-review');
const smokeCommand = process.argv.includes('--smoke-command');
const demoCommand = process.argv.includes('--demo-command');
const smokeStudio = process.argv.includes('--smoke-studio');
const smokePolicy = process.argv.includes('--smoke-policy');
const smokeEdit = process.argv.includes('--smoke-edit');
const smokeTranscript = process.argv.includes('--smoke-transcript');
const smokeHostReady = process.argv.includes('--smoke-host');
const smokeHostChat = process.argv.includes('--smoke-host-chat');
const smokeHost = smokeHostReady || smokeHostChat;
const smoke = process.argv.includes('--smoke')
  || smokeReview
  || smokeCommand
  || smokeStudio
  || smokePolicy
  || smokeEdit
  || smokeTranscript
  || smokeHost;
const useDemoConnection = (smoke && !smokeHost)
  || demoReview
  || demoCommand;
const port = readLocalServerPort();
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
  content: 'PinPawo TUI v2 · connecting',
  fg: '#f0a6ca',
  bg: RGBA.defaultBackground(),
  height: 1,
});
const live = new TextRenderable(renderer, {
  id: 'live',
  content: 'live · idle',
  bg: RGBA.defaultBackground(),
  height: 1,
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
let sessionPickerGeneration = 0;
let policyPickerGeneration = 0;
let sessionListRequest: ReturnType<TuiSessionController['listSessions']> | null = null;
let composerMode: 'chat' | 'studio' = 'chat';
let studioConversationId: string | null = null;
let focusedSessionId = 'pending';
let studioSmokeStarted = false;
let studioSmokeFinished = false;
let policySmokeStarted = false;
let policySmokeFinished = false;
let editSmokeStarted = false;
let transcriptSmokeStarted = false;
let hostSmokeFinished = false;
let terminalHandoffOpen = false;
let composerHistory = createComposerHistoryState();
const controller = new TuiSessionController({
  connectionFactory: useDemoConnection
    ? createDemoConnectionFactory({ review: smokeReview || demoReview })
    : createLocalHostConnectionFactory({ port }),
});
const timeline = new TimelineScrollback(renderer);
const approvalController = new ApprovalController({
  sessionController: controller,
  getWidth: () => renderer.width,
  onChange: () => refreshApproval(),
});
const approvalView = new ApprovalView(renderer, {
  onDraftChange: (draft) => approvalController.setDraft(draft),
});
const composer = new TextareaRenderable(renderer, {
  id: 'composer',
  width: '100%',
  height: '100%',
  backgroundColor: RGBA.defaultBackground(),
  focusedBackgroundColor: RGBA.defaultBackground(),
  placeholder: 'Message · Ctrl+Enter to send',
  keyBindings: [{
    name: 'return',
    ctrl: true,
    action: 'submit',
  }],
  onSubmit: () => submitComposerInput(),
  onContentChange: () => {
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
  },
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
installSingleGraphemeBackspaceWorkaround(composer);
installSingleGraphemeBackspaceWorkaround(approvalView.input);

root.add(header);
root.add(live);
composerFrame.add(composer);
root.add(composerFrame);
root.add(status);
root.add(commandOverlayView.frame);
root.add(fileMentionView.frame);
root.add(sessionPickerView.frame);
root.add(policyPickerView.frame);
root.add(noticeOverlayView.frame);
root.add(approvalView.frame);
renderer.root.add(root);
if (smokeCommand || demoCommand) {
  composer.setText('/');
  composer.gotoBufferEnd();
}
composer.focus();
syncComposerInputOverlays();

const unsubscribe = controller.subscribe((state) => {
  if (state.session.sessionId !== focusedSessionId) {
    focusedSessionId = state.session.sessionId;
    composerMode = state.session.kind;
    studioConversationId = null;
    syncComposerModeUi();
  }
  syncApprovalFromSession();
  syncNoticeFromSession();
  refreshHeader();
  refreshLive();
  if (state.session.sessionId !== 'pending') {
    timeline.renderWelcome(buildWelcomeLines({
      session: state.session,
      width: renderer.width,
      connection: formatConnection(state.connection),
    }));
  }
  if (!terminalHandoffOpen) {
    timeline.render(state.session);
  }
  refreshStatus();
  if (
    smokeStudio
    && !studioSmokeStarted
    && state.connection === 'ready'
  ) {
    studioSmokeStarted = true;
    queueMicrotask(() => submitComposerInput('/studio verify Studio mode'));
  } else if (
    smokeStudio
    && studioSmokeStarted
    && !studioSmokeFinished
    && !state.session.activeRun
    && state.session.timeline.some((entry) => (
      entry.type === 'message'
      && entry.text === 'Studio demo completed.'
    ))
  ) {
    studioSmokeFinished = true;
    setTimeout(() => renderer.destroy(), 50);
  } else if (
    smokePolicy
    && !policySmokeStarted
    && state.connection === 'ready'
  ) {
    policySmokeStarted = true;
    queueMicrotask(() => {
      submitComposerInput('/policy');
      handlePolicyPickerAction('move-down');
      handlePolicyPickerAction('select');
    });
  } else if (
    smokePolicy
    && policySmokeStarted
    && !policySmokeFinished
    && state.session.runtime?.globalReviewPolicyMode === 'auto_authorization'
  ) {
    policySmokeFinished = true;
    setTimeout(() => renderer.destroy(), 50);
  } else if (
    smokeEdit
    && !editSmokeStarted
    && state.connection === 'ready'
  ) {
    editSmokeStarted = true;
    queueMicrotask(() => submitComposerInput('/edit smoke draft'));
  } else if (
    smokeTranscript
    && !transcriptSmokeStarted
    && state.connection === 'ready'
  ) {
    transcriptSmokeStarted = true;
    queueMicrotask(() => submitComposerInput('/transcript'));
  } else if (
    smokeHostReady
    && !hostSmokeFinished
    && state.connection === 'ready'
  ) {
    hostSmokeFinished = true;
    setTimeout(() => renderer.destroy(), 50);
  } else if (
    smokeHostChat
    && !hostSmokeFinished
    && state.session.activeRun === null
    && state.session.timeline.some((entry) => (
      entry.type === 'message'
      && entry.role === 'assistant'
      && entry.status === 'completed'
    ))
  ) {
    hostSmokeFinished = true;
    setTimeout(() => renderer.destroy(), 50);
  }
});
renderer.keyInput.on('keypress', (key) => {
  const approval = approvalController.getState();
  if (key.ctrl && !key.shift && key.name === 'c') {
    key.preventDefault();
    key.stopPropagation();
    handleGlobalInterrupt(approval.phase);
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
  const approvalAction = resolveApprovalKey(approval, key);
  if (approval.phase !== 'closed') {
    if (approvalAction) {
      key.preventDefault();
      key.stopPropagation();
      approvalController.handle(approvalAction);
      return;
    }
    if (approvalAcceptsTextInput(approval)) return;
    key.preventDefault();
    key.stopPropagation();
    return;
  }
  const noticeAction = resolveNoticeOverlayKey(noticeOverlay, key);
  if (noticeOverlay.phase !== 'closed') {
    key.preventDefault();
    key.stopPropagation();
    if (noticeAction === 'close') {
      closeNoticeOverlayUi();
    }
    return;
  }
  const policyAction = resolvePolicyPickerKey(policyPicker, key);
  if (policyPicker.phase !== 'closed') {
    key.preventDefault();
    key.stopPropagation();
    handlePolicyPickerAction(policyAction);
    return;
  }
  syncComposerInputOverlays();
  const commandAction = resolveCommandOverlayKey(commandOverlay, key);
  if (
    commandOverlay.phase === 'help'
  ) {
    key.preventDefault();
    key.stopPropagation();
    handleCommandOverlayAction(commandAction);
    return;
  }
  const pickerAction = resolveSessionPickerKey(sessionPicker, key);
  if (sessionPicker.phase !== 'closed') {
    key.preventDefault();
    key.stopPropagation();
    handleSessionPickerAction(pickerAction);
    return;
  }
  if (pickerAction === 'open') {
    key.preventDefault();
    key.stopPropagation();
    openSessionPicker();
    return;
  }
  if (commandOverlay.phase === 'palette' && commandAction) {
    key.preventDefault();
    key.stopPropagation();
    handleCommandOverlayAction(commandAction);
    return;
  }
  const fileMentionAction = resolveFileMentionKey(fileMention, key);
  if (fileMention.phase === 'open' && fileMentionAction) {
    key.preventDefault();
    key.stopPropagation();
    handleFileMentionAction(fileMentionAction);
    return;
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
  const approval = approvalController.getState();
  if (approval.phase !== 'closed') {
    if (approvalAcceptsTextInput(approval)) return;
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (noticeOverlay.phase !== 'closed') {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (policyPicker.phase !== 'closed') {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (commandOverlay.phase === 'help') {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (sessionPicker.phase === 'closed') {
    releaseStickyComposerNotice();
    return;
  }
  event.preventDefault();
  event.stopPropagation();
});
renderer.on('resize', () => {
  syncComposerLayout();
  refreshLive();
  refreshSessionPicker();
  refreshPolicyPicker();
  refreshApproval();
  refreshCommandOverlay();
  refreshFileMention();
  refreshNoticeOverlay();
});
renderer.on('destroy', () => {
  sessionPickerGeneration += 1;
  policyPickerGeneration += 1;
  sessionPicker = closeSessionPicker(sessionPicker);
  policyPicker = closePolicyPicker(policyPicker);
  commandOverlay = closeCommandOverlay();
  fileMention = createFileMentionState();
  noticeOverlay = closeNoticeOverlay();
  approvalController.destroy();
  unsubscribe();
  controller.stop();
  timeline.destroy();
});

syncComposerLayout();
syncComposerModeUi();
controller.start();

if (smokeCommand) {
  renderer.once('frame', () => {
    composer.setText('Smoke footer repaint.');
    composer.gotoBufferEnd();
    submitComposerInput();
    renderer.once('frame', () => {
      setTimeout(() => renderer.destroy(), 50);
    });
  });
} else if (
  smoke
  && !smokeHost
  && !smokeStudio
  && !smokePolicy
  && !smokeEdit
  && !smokeTranscript
) {
  renderer.once('frame', () => {
    setTimeout(() => renderer.destroy(), 50);
  });
}

function syncComposerLayout() {
  const layout = calculateComposerLayout(
    composer.plainText,
    composer.virtualLineCount,
    {
      commandPalette: commandOverlay.phase === 'palette',
      persistentHeader: attachments.length > 0,
    },
  );
  composerFrame.border = commandOverlay.phase === 'palette'
    ? ['top']
    : true;
  composerFrame.height = layout.frameHeight;
  header.height = layout.headerHeight;
  live.height = layout.liveHeight;
  status.height = layout.statusHeight;
}

function refreshHeader() {
  header.content = truncateTerminalLine(attachments.length
    ? formatAttachmentStrip(attachments)
    : formatHeader(
        controller.getState(),
        renderer.width,
        composerMode,
      ), renderer.width);
}

function syncComposerModeUi() {
  composer.placeholder = composerMode === 'studio'
    ? 'Studio task · Ctrl+Enter to run · /chat to exit'
    : 'Message · Ctrl+Enter to send';
  refreshHeader();
}

function refreshLive() {
  live.content = truncateTerminalLine(
    `live · ${formatLiveSession(
      controller.getState().session,
      Math.max(1, renderer.width - 7),
    )}`,
    renderer.width,
  );
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
      && noticeOverlay.phase === 'closed'
      && approvalController.getState().phase === 'closed',
  );
  refreshFileMention();
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
  placeComposerCursorAtTextOffset(
    composer,
    completion.text,
    completion.cursorOffset,
  );
  syncComposerInputOverlays();
  syncComposerLayout();
}

function syncNoticeFromSession() {
  const previous = noticeOverlay;
  noticeOverlay = syncNoticeOverlay(
    noticeOverlay,
    controller.getState(),
  );
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
    composer.blur();
  } else if (
    previous.phase === 'interrupting'
    && !terminalHandoffOpen
    && approvalController.getState().phase === 'closed'
  ) {
    if (localNotice?.startsWith('interrupt requested')) {
      localNotice = null;
    }
    composer.focus();
    syncComposerInputOverlays();
  }
  refreshNoticeOverlay();
}

function closeNoticeOverlayUi() {
  noticeOverlay = closeNoticeOverlay();
  refreshNoticeOverlay();
  if (
    !terminalHandoffOpen
    && approvalController.getState().phase === 'closed'
    && policyPicker.phase === 'closed'
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
  noticeOverlayView.render(noticeOverlay, renderer.width);
}

function handleGlobalInterrupt(
  approvalPhase: ReturnType<ApprovalController['getState']>['phase'],
) {
  const action = resolveGlobalInterruptAction({
    approvalPhase,
    activeRun: controller.getState().session.activeRun,
  });
  if (action === 'cancel-review') {
    approvalController.handle('cancel');
    return;
  }
  if (action === 'interrupt-run') {
    requestRunInterrupt();
    return;
  }
  renderer.destroy();
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
    controller.getState().session.activeRun,
    controller.getState().connection,
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
    composer.blur();
  } else if (
    previous.phase !== 'closed'
    && !terminalHandoffOpen
    && sessionPicker.phase === 'closed'
    && policyPicker.phase === 'closed'
    && noticeOverlay.phase === 'closed'
  ) {
    composer.focus();
    syncComposerInputOverlays();
  }
  refreshApproval();
}

function refreshApproval() {
  const approval = approvalController.getState();
  approvalView.render(approval, renderer.width);
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
  commandOverlay = closeCommandOverlay();
  closeFileMentionOverlay();
  refreshCommandOverlay();
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
  if (!terminalHandoffOpen && noticeOverlay.phase === 'closed') {
    composer.focus();
    syncComposerInputOverlays();
  }
}

function refreshSessionPicker() {
  sessionPickerView.render(sessionPicker, renderer.width);
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
  policyPickerGeneration += 1;
  policyPicker = openPolicyPicker(policyPicker, currentMode);
  composer.blur();
  refreshCommandOverlay();
  refreshSessionPicker();
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
  void controller.updateGlobalReviewPolicy(option.mode).then((result) => {
    if (
      policyPickerGeneration !== generation
      || policyPicker.phase !== 'saving'
    ) {
      return;
    }
    policyPicker = closePolicyPicker({
      ...policyPicker,
      currentMode: result.globalReviewPolicyMode,
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
    && noticeOverlay.phase === 'closed'
    && approvalController.getState().phase === 'closed'
  ) {
    composer.focus();
    syncComposerInputOverlays();
  }
}

function refreshPolicyPicker() {
  policyPickerView.render(policyPicker, renderer.width);
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
  const parsed = attachments.length === 0
    ? parseTuiCommand(input)
    : { type: 'text' as const, text: input };
  if (parsed.type === 'empty') return;
  if (parsed.type === 'unknown') {
    clearComposerPreservingNotice();
    localNotice = `unknown command: ${parsed.raw} · use /help`;
    refreshStatus();
    return;
  }
  if (parsed.type === 'command') {
    if (parsed.name === 'quit') {
      renderer.destroy();
      return;
    }
    if (parsed.name === 'help') {
      composer.clear();
      localNotice = null;
      openCommandHelpUi();
      return;
    }
    if (parsed.name === 'resume') {
      composer.clear();
      localNotice = null;
      openSessionPicker();
      return;
    }
    if (parsed.name === 'policy') {
      composer.clear();
      localNotice = null;
      openPolicyPickerUi();
      return;
    }
    if (parsed.name === 'transcript') {
      openTranscriptPager();
      return;
    }
    if (parsed.name === 'export') {
      exportCurrentTranscript(parsed.args || undefined);
      return;
    }
    if (parsed.name === 'edit') {
      openExternalEditor(parsed.args);
      return;
    }
    if (parsed.name === 'chat') {
      enterChatMode();
      return;
    }
    if (parsed.name === 'studio') {
      if (!parsed.args) {
        if (composerMode === 'studio') {
          enterChatMode();
        } else {
          enterStudioMode();
        }
        return;
      }
      enterStudioMode(false);
      submitStudioInput(parsed.args);
      return;
    }
    if (parsed.name === 'new') {
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
    }
    return;
  }

  if (composerMode === 'studio') {
    submitStudioInput(parsed.text);
    return;
  }

  const result = controller.submitChat(parsed.text, attachments);
  if (result.ok) {
    composerHistory = recordComposerHistoryEntry(
      composerHistory,
      parsed.text,
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

  const operation = smokeEdit
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
      && noticeOverlay.phase === 'closed'
      && approvalController.getState().phase === 'closed'
    ) {
      composer.focus();
      syncComposerInputOverlays();
    }
    if (smokeEdit) {
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
    ...(smokeTranscript
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
      && noticeOverlay.phase === 'closed'
      && approvalController.getState().phase === 'closed'
    ) {
      composer.focus();
      syncComposerInputOverlays();
    }
    if (smokeTranscript) {
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

function submitFailureText(reason: 'not-ready' | 'busy' | 'empty' | 'send-failed') {
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
