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
import { calculateComposerLayout } from './spike/composerLayout';
import { installSingleGraphemeBackspaceWorkaround } from './spike/textareaWorkarounds';
import {
  formatHeader,
  formatStatusLine,
} from './status/statusModel';
import { formatLiveSession } from './timeline/timelineModel';
import { TimelineScrollback } from './timeline/timelineScrollback';

const smoke = process.argv.includes('--smoke');
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

let localNotice: string | null = null;
let pendingComposerNotice: string | null = null;
let attachments: AgentLocalAttachment[] = [];
const controller = new TuiSessionController({
  connectionFactory: smoke
    ? createSmokeConnectionFactory()
    : createLocalHostConnectionFactory({ port }),
});
const timeline = new TimelineScrollback(renderer);
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

root.add(header);
root.add(live);
composerFrame.add(composer);
root.add(composerFrame);
root.add(status);
renderer.root.add(root);
composer.focus();

const unsubscribe = controller.subscribe((state) => {
  refreshHeader();
  live.content = `live · ${formatLiveSession(state.session)}`;
  timeline.render(state.session);
  refreshStatus();
});
renderer.keyInput.on('keypress', (key) => {
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
renderer.on('resize', syncComposerLayout);
renderer.on('destroy', () => {
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

function refreshStatus() {
  status.content = localNotice ?? formatStatusLine(controller.getState());
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

function createSmokeConnectionFactory(): TuiAgentHostConnectionFactory {
  return (handlers) => {
    let connected = false;
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
                text: 'Smoke test the Phase 2 vertical slice.',
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
              }],
              activeRun: null,
            }),
          });
        }
        return true;
      },
    };
  };
}
