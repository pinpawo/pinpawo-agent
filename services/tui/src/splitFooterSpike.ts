import {
  BoxRenderable,
  TextareaRenderable,
  TextRenderable,
  createCliRenderer,
  type KeyEvent,
  type PasteEvent,
  type ScrollbackRenderContext,
} from '@opentui/core';
import { formatInputProbe } from './spike/inputProbe';
import {
  createSpikeSession,
  formatSpikeTimelineEntry,
} from './spike/sessionHarness';

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
});
const header = new TextRenderable(renderer, {
  id: 'header',
  content: 'PinPawo TUI v2 · split-footer / terminal scrollback probe',
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
  padding: 1,
});
const status = new TextRenderable(renderer, {
  id: 'status',
  content: 'Ctrl+D live delta · Ctrl+T scrollback rows · Ctrl+C exit',
  fg: '#8a8a8a',
  height: 1,
});
const composer = new TextareaRenderable(renderer, {
  id: 'composer',
  width: '100%',
  height: '100%',
  placeholder: 'Footer composer: multiline, paste, IME, file drag-in…',
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
    status.content = `composer: ${[...composer.plainText].length} code points`;
  },
});

root.add(header);
root.add(live);
composerFrame.add(composer);
root.add(composerFrame);
root.add(status);
renderer.root.add(root);
composer.focus();

let scrollbackSequence = 0;
let burstSequence = 0;
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
renderer.keyInput.on('paste', (event: PasteEvent) => {
  status.content = formatInputProbe(
    'paste',
    new TextDecoder().decode(event.bytes),
  );
});
renderer.on('resize', (width, height) => {
  status.content = `resize: ${width}×${height}`;
});
renderer.on('selection', (selection) => {
  status.content = `selection: ${[...selection.getSelectedText()].length} code points`;
});

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

function runLiveDeltaBurst() {
  burstSequence += 1;
  const currentBurst = burstSequence;
  let tick = 0;
  const timer = setInterval(() => {
    tick += 1;
    live.content = `live       delta burst ${currentBurst}: ${'▮'.repeat(tick % 40)}`;
    if (tick >= 400) {
      clearInterval(timer);
      writeScrollbackLine(`assistant  delta burst ${currentBurst}: completed (400 updates)`);
      live.content = 'live       idle';
      status.content = 'live delta committed to terminal scrollback';
    }
  }, 8);
}

function appendScrollbackBurst() {
  for (let index = 0; index < 250; index += 1) {
    writeScrollbackLine(`system     scrollback row ${index + 1}/250 · 宽字符 🙂`);
  }
  status.content = 'committed 250 rows to terminal scrollback';
}
