import {
  BoxRenderable,
  RGBA,
  TextareaRenderable,
  TextRenderable,
  createCliRenderer,
  type KeyEvent,
  type PasteEvent,
  type ScrollbackRenderContext,
  type ScrollbackSurface,
} from '@opentui/core';
import { calculateComposerLayout } from './spike/composerLayout';
import { formatInputProbe } from './spike/inputProbe';
import {
  createSpikeSession,
  formatSpikeTimelineEntry,
} from './spike/sessionHarness';
import { installSingleGraphemeBackspaceWorkaround } from './spike/textareaWorkarounds';

const smoke = process.argv.includes('--smoke');
const renderer = await createCliRenderer({
  exitOnCtrlC: true,
  targetFps: 60,
  // Native scrollback only works when the terminal owns wheel and selection
  // input. OpenTUI mouse tracking would consume those events in the footer.
  useMouse: false,
  enableMouseMovement: false,
  screenMode: 'split-footer',
  footerHeight: 8,
  externalOutputMode: 'capture-stdout',
  consoleMode: 'disabled',
});
const root = new BoxRenderable(renderer, {
  id: 'split-footer',
  width: '100%',
  height: '100%',
  flexDirection: 'column',
  backgroundColor: RGBA.defaultBackground(),
});
const header = new TextRenderable(renderer, {
  id: 'header',
  content: 'PinPawo TUI v2 · split-footer',
  fg: '#f0a6ca',
  height: 1,
});
const live = new TextRenderable(renderer, {
  id: 'live',
  content: 'live       idle',
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
  content: 'Ctrl+D surface delta · Ctrl+T scrollback rows · Ctrl+C exit',
  fg: '#8a8a8a',
  height: 1,
});
let pendingPastePreview: string | null = null;
const composer = new TextareaRenderable(renderer, {
  id: 'composer',
  width: '100%',
  height: '100%',
  placeholder: 'Message · multiline / paste / IME / file paths',
  keyBindings: [{
    name: 'return',
    ctrl: true,
    action: 'submit',
  }],
  onSubmit: () => {
    if (!composer.plainText.trim()) return;
    writeScrollbackLine(`user       ${composer.plainText}`);
    composer.clear();
    status.content = 'submitted to terminal scrollback only';
  },
  onContentChange: () => {
    status.content = pendingPastePreview
      ?? `composer: ${[...composer.plainText].length} code points`;
    pendingPastePreview = null;
    syncComposerLayout();
  },
  onPaste: (event: PasteEvent) => {
    pendingPastePreview = formatInputProbe(
      'paste',
      new TextDecoder().decode(event.bytes),
    );
    status.content = pendingPastePreview;
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

let scrollbackSequence = 0;
let burstSequence = 0;
let activeDeltaTimer: ReturnType<typeof setInterval> | null = null;
let activeDeltaSurface: ScrollbackSurface | null = null;
for (const entry of createSpikeSession(smoke ? 2 : 40).timeline) {
  writeScrollbackLine(formatSpikeTimelineEntry(entry));
}

renderer.keyInput.on('keypress', (key: KeyEvent) => {
  status.content = formatInputProbe('key', key.raw);
  if (key.ctrl && key.name === 'd') {
    runLiveDeltaBurst();
    return;
  }
  if (key.ctrl && key.name === 't') {
    appendScrollbackBurst();
  }
});
renderer.on('resize', syncComposerLayout);
renderer.on('selection', (selection) => {
  status.content = `selection: ${[...selection.getSelectedText()].length} code points`;
});
renderer.on('destroy', stopActiveDeltaBurst);

if (smoke) {
  renderer.once('frame', () => {
    setTimeout(() => renderer.destroy(), 50);
  });
}

function writeScrollbackLine(content: string) {
  renderer.writeToScrollback((context: ScrollbackRenderContext) => {
    const text = new TextRenderable(context.renderContext, {
      id: `scrollback-${scrollbackSequence += 1}`,
      position: 'absolute',
      width: context.width,
      height: 1,
      content,
    });
    return {
      root: text,
      width: context.width,
      height: 1,
    };
  });
}

function syncComposerLayout() {
  const layout = calculateComposerLayout(
    composer.plainText,
    composer.virtualLineCount,
  );
  composerFrame.height = layout.frameHeight;
  header.height = layout.headerHeight;
  live.height = layout.liveHeight;
}

function runLiveDeltaBurst() {
  if (activeDeltaTimer) {
    status.content = 'surface delta is already running';
    return;
  }

  burstSequence += 1;
  const currentBurst = burstSequence;
  const surface = renderer.createScrollbackSurface({ startOnNewLine: true });
  const streamedText = new TextRenderable(surface.renderContext, {
    id: `delta-surface-${currentBurst}`,
    width: '100%',
    height: 'auto',
    content: 'assistant  ',
  });
  surface.root.add(streamedText);
  activeDeltaSurface = surface;

  let tick = 0;
  let committedRows = 0;
  let content = 'assistant  ';
  live.content = `live       surface delta ${currentBurst}: streaming`;
  status.content = 'scroll history now; only stable rows will be committed';

  activeDeltaTimer = setInterval(() => {
    tick += 1;
    content += '▮';
    streamedText.content = content;
    surface.render();

    const stableRows = tick >= 400
      ? surface.height
      : Math.max(0, surface.height - 1);
    if (stableRows > committedRows) {
      surface.commitRows(committedRows, stableRows);
      committedRows = stableRows;
    }

    if (tick >= 400) {
      clearInterval(activeDeltaTimer!);
      activeDeltaTimer = null;
      surface.destroy();
      activeDeltaSurface = null;
      live.content = 'live       idle';
      status.content = `surface delta ${currentBurst} completed (400 updates)`;
    }
  }, 8);
}

function stopActiveDeltaBurst() {
  if (activeDeltaTimer) {
    clearInterval(activeDeltaTimer);
    activeDeltaTimer = null;
  }
  if (activeDeltaSurface && !activeDeltaSurface.isDestroyed) {
    activeDeltaSurface.destroy();
  }
  activeDeltaSurface = null;
}

function appendScrollbackBurst() {
  for (let index = 0; index < 250; index += 1) {
    writeScrollbackLine(`system     scrollback row ${index + 1}/250 · 宽字符 🙂`);
  }
  status.content = 'committed 250 rows to terminal scrollback';
}
