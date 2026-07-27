import {
  BoxRenderable,
  RGBA,
  TextareaRenderable,
  TextRenderable,
  createCliRenderer,
  type PasteEvent,
} from '@opentui/core';
import {
  createAgentSessionSnapshot,
  type AgentLocalAttachment,
} from '@pinpawo/agent-session';
import {
  formatAttachmentStrip,
  mergeAttachments,
  removeLastAttachment,
} from './attachments/attachmentModel';
import { ingestLocalPathPaste } from './attachments/localPathIngestion';
import {
  createLocalHostConnectionFactory,
  readLocalServerPort,
  type AgentHostConnectionFactory as TuiAgentHostConnectionFactory,
} from './client/localHostConnection';
import { TuiSessionController } from './session/sessionController';
import {
  approvalAcceptsTextInput,
  resolveApprovalKey,
} from './overlays/approvalModel';
import { ApprovalController } from './overlays/approvalController';
import { ApprovalView } from './overlays/approvalView';
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
  formatHeader,
  formatStatusLine,
} from './status/statusModel';
import { formatLiveSession } from './timeline/timelineModel';
import { TimelineScrollback } from './timeline/timelineScrollback';

const smokeReview = process.argv.includes('--smoke-review');
const demoReview = process.argv.includes('--demo-review');
const smoke = process.argv.includes('--smoke') || smokeReview;
const port = readLocalServerPort();
const renderer = await createCliRenderer({
  exitOnCtrlC: true,
  targetFps: 60,
  useMouse: false,
  enableMouseMovement: false,
  screenMode: 'split-footer',
  footerHeight: 8,
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
  height: 1,
});
const live = new TextRenderable(renderer, {
  id: 'live',
  content: 'live · idle',
  height: 1,
});
const composerFrame = new BoxRenderable(renderer, {
  id: 'composer-frame',
  width: '100%',
  height: 5,
  border: true,
  paddingLeft: 1,
  paddingRight: 1,
});
const status = new TextRenderable(renderer, {
  id: 'status',
  content: `local-agent :${port}`,
  fg: '#8a8a8a',
  height: 1,
});
const sessionPickerView = new SessionPickerView(renderer);

let localNotice: string | null = null;
let pendingComposerNotice: string | null = null;
let attachments: AgentLocalAttachment[] = [];
let sessionPicker = createSessionPickerState();
let sessionPickerGeneration = 0;
let sessionListRequest: ReturnType<TuiSessionController['listSessions']> | null = null;
const controller = new TuiSessionController({
  connectionFactory: smoke || demoReview
    ? createSmokeConnectionFactory({ review: smokeReview || demoReview })
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
  placeholder: 'Message · Ctrl+Enter to send',
  keyBindings: [{
    name: 'return',
    ctrl: true,
    action: 'submit',
  }],
  onSubmit: () => {
    if (composer.plainText.trim() === '/resume' && attachments.length === 0) {
      composer.clear();
      localNotice = null;
      openSessionPicker();
      return;
    }
    const result = controller.submitChat(composer.plainText, attachments);
    if (result.ok) {
      attachments = [];
      composer.clear();
      localNotice = null;
      refreshHeader();
      syncComposerLayout();
    } else {
      localNotice = submitFailureText(result.reason);
      refreshStatus();
    }
  },
  onContentChange: () => {
    localNotice = pendingComposerNotice;
    pendingComposerNotice = null;
    syncComposerLayout();
    refreshStatus();
  },
  onPaste: (event: PasteEvent) => {
    const input = new TextDecoder().decode(event.bytes);
    const result = ingestLocalPathPaste(input, {
      existingPaths: new Set(attachments.map((attachment) => attachment.path)),
    });
    if (result.kind === 'attachments') {
      event.preventDefault();
      const previousCount = attachments.length;
      attachments = mergeAttachments(attachments, result.attachments);
      const addedCount = attachments.length - previousCount;
      localNotice = attachmentIngestionNotice(
        addedCount,
        result.duplicateCount,
        result.attachments.length - addedCount,
      );
      refreshHeader();
      syncComposerLayout();
      refreshStatus();
    } else if (result.pathLike) {
      pendingComposerNotice = `${result.issue}; inserted as text`;
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
root.add(sessionPickerView.frame);
root.add(approvalView.frame);
renderer.root.add(root);
composer.focus();

const unsubscribe = controller.subscribe((state) => {
  syncApprovalFromSession();
  refreshHeader();
  refreshLive();
  timeline.render(state.session);
  refreshStatus();
});
renderer.keyInput.on('keypress', (key) => {
  const approval = approvalController.getState();
  const approvalAction = resolveApprovalKey(approval, key);
  if (approval.phase !== 'closed' && !(key.ctrl && key.name === 'c')) {
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
  const pickerAction = resolveSessionPickerKey(sessionPicker, key);
  if (sessionPicker.phase !== 'closed' && !(key.ctrl && key.name === 'c')) {
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
  if (sessionPicker.phase === 'closed') return;
  event.preventDefault();
  event.stopPropagation();
});
renderer.on('resize', () => {
  syncComposerLayout();
  refreshLive();
  refreshSessionPicker();
  refreshApproval();
});
renderer.on('destroy', () => {
  sessionPickerGeneration += 1;
  sessionPicker = closeSessionPicker(sessionPicker);
  approvalController.destroy();
  unsubscribe();
  controller.stop();
  timeline.destroy();
});

syncComposerLayout();
controller.start();

if (smoke) {
  renderer.once('frame', () => {
    setTimeout(() => renderer.destroy(), 50);
  });
}

function syncComposerLayout() {
  const layout = calculateComposerLayout(
    composer.plainText,
    composer.virtualLineCount,
    { persistentHeader: attachments.length > 0 },
  );
  composerFrame.height = layout.frameHeight;
  header.height = layout.headerHeight;
  live.height = layout.liveHeight;
}

function refreshHeader() {
  header.content = attachments.length
    ? formatAttachmentStrip(attachments)
    : formatHeader(controller.getState());
}

function refreshLive() {
  live.content = `live · ${formatLiveSession(
    controller.getState().session,
    Math.max(16, Math.floor((renderer.width - 7) / 2)),
  )}`;
}

function refreshStatus() {
  status.content = localNotice ?? formatStatusLine(controller.getState());
}

function syncApprovalFromSession() {
  const previous = approvalController.getState();
  approvalController.sync(
    controller.getState().session.activeRun,
    controller.getState().connection,
  );
  const approval = approvalController.getState();
  if (approval.phase !== 'closed') {
    if (sessionPicker.phase !== 'closed') {
      sessionPickerGeneration += 1;
      sessionPicker = closeSessionPicker(sessionPicker);
      refreshSessionPicker();
    }
    composer.blur();
  } else if (
    previous.phase !== 'closed'
    && sessionPicker.phase === 'closed'
  ) {
    composer.focus();
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
  if (sessionPicker.phase !== 'closed') return;
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
    composer.clear();
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
  composer.focus();
}

function refreshSessionPicker() {
  sessionPickerView.render(sessionPicker, renderer.width);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function attachmentIngestionNotice(
  added: number,
  duplicates: number,
  overLimit: number,
) {
  if (added === 0 && overLimit > 0) {
    return 'attachment limit reached';
  }
  if (added === 0 && duplicates > 0) {
    return 'attachment already added';
  }
  return [
    `attached ${added} local path${added === 1 ? '' : 's'}`,
    ...(duplicates > 0 ? [`skipped ${duplicates} duplicate${duplicates === 1 ? '' : 's'}`] : []),
    ...(overLimit > 0 ? [`skipped ${overLimit} over limit`] : []),
  ].join(' · ');
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

function createSmokeConnectionFactory(
  options: { review?: boolean } = {},
): TuiAgentHostConnectionFactory {
  return (handlers) => {
    let connected = false;
    let reviewResolved = false;
    return {
      connect: () => {
        connected = true;
        handlers.onOpen();
      },
      disconnect: () => {
        connected = false;
      },
      isConnected: () => connected,
      send: (message) => {
        if (!connected) return false;
        if (message.type === 'session.snapshot.get') {
          handlers.onMessage({
            type: 'session.snapshot.result',
            requestId: message.requestId,
            snapshot: createAgentSessionSnapshot({
              sessionId: 'smoke',
              kind: 'chat',
              timeline: [{
                id: 'smoke-user',
                type: 'message',
                role: 'user',
                text: 'Smoke test the Phase 4 vertical slice.',
                status: 'completed',
              }, {
                id: 'smoke-operation',
                type: 'operation',
                requestId: 'smoke-run',
                operationKey: 'smoke-operation',
                kind: 'smoke',
                title: 'Render timeline surface',
                phase: 'completed',
                summary: 'ok',
              }, {
                id: 'smoke-assistant',
                type: 'message',
                role: 'assistant',
                text: 'Connection, projection, and timeline are aligned.',
                status: 'completed',
              }, ...(reviewResolved
                ? [{
                    id: 'smoke-review-result',
                    type: 'message' as const,
                    role: 'assistant' as const,
                    requestId: 'smoke-run',
                    text: 'The review demo completed.',
                    status: 'completed' as const,
                  }]
                : [])],
              activeRun: options.review && !reviewResolved
                ? {
                    requestId: 'smoke-run',
                    state: 'waiting_review',
                    reviewAction: {
                      actionId: 'smoke-review-action',
                      petId: 'paws',
                      reviews: [{
                        id: 'smoke-review',
                        schemaVersion: 1,
                        view: {
                          kind: 'plain',
                          title: 'Allow local operation?',
                          body: 'Review details remain pageable inside the fixed footer.',
                        },
                        options: [{
                          id: 'approve',
                          label: 'Approve',
                          variant: 'primary',
                          decision: { type: 'approve' },
                        }, {
                          id: 'respond',
                          label: 'Respond',
                          input: {
                            kind: 'text',
                            key: 'message',
                            multiline: true,
                          },
                          decision: {
                            type: 'respond',
                            messageInputKey: 'message',
                          },
                        }, {
                          id: 'reject',
                          label: 'Reject',
                          variant: 'danger',
                          decision: { type: 'reject' },
                        }],
                      }],
                    },
                  }
                : null,
            }),
          });
        }
        if (
          options.review
          && (
            message.type === 'human_review_response'
            || message.type === 'review.cancel'
          )
        ) {
          reviewResolved = true;
          if (message.type === 'review.cancel') {
            handlers.onMessage({
              type: 'interrupted',
              requestId: 'smoke-run',
              message: 'Review demo cancelled.',
            });
          } else {
            handlers.onMessage({
              type: 'event',
              requestId: 'smoke-run',
              event: {
                type: 'message.completed',
                requestId: 'smoke-run',
                role: 'assistant',
                text: 'The review demo completed.',
              },
            });
          }
        }
        return true;
      },
    };
  };
}
