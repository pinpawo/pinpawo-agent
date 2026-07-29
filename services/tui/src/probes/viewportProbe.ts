import {
  BoxRenderable,
  ScrollBoxRenderable,
  TextareaRenderable,
  TextRenderable,
  createCliRenderer,
  type KeyEvent,
  type PasteEvent,
} from '@opentui/core';
import { COMPOSER_KEY_BINDINGS } from '../input/composerKeyBindings';
import { formatInputProbe } from './inputProbe';
import {
  createSpikeSession,
  formatSpikeTimelineEntry,
} from './sessionHarness';

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
  targetFps: 60,
  consoleMode: 'disabled',
});
const root = new BoxRenderable(renderer, {
  id: 'app',
  width: '100%',
  height: '100%',
  flexDirection: 'column',
});
const header = new TextRenderable(renderer, {
  id: 'header',
  content: 'PinPawo TUI v2 · OpenTUI Phase 1 capability spike',
  fg: '#f0a6ca',
  height: 1,
});
const status = new TextRenderable(renderer, {
  id: 'status',
  content: 'F2 timeline · F3 composer · Ctrl+D delta · Ctrl+T rows · Ctrl+C exit',
  fg: '#8a8a8a',
  height: 1,
});
const timeline = new ScrollBoxRenderable(renderer, {
  id: 'timeline',
  width: '100%',
  flexGrow: 1,
  stickyScroll: true,
  stickyStart: 'bottom',
  viewportCulling: true,
  contentOptions: {
    flexDirection: 'column',
  },
});
const composerFrame = new BoxRenderable(renderer, {
  id: 'composer-frame',
  width: '100%',
  height: 6,
  border: true,
  padding: 1,
});
const composer = new TextareaRenderable(renderer, {
  id: 'composer',
  width: '100%',
  height: '100%',
  placeholder: '多行输入、宽字符、emoji、paste；拖入文件路径观察 raw input…',
  keyBindings: COMPOSER_KEY_BINDINGS,
  onSubmit: () => {
    status.content = `submit (${[...composer.plainText].length} code points): ${composer.plainText}`;
  },
  onContentChange: () => {
    status.content = `composer: ${[...composer.plainText].length} code points`;
  },
});

root.add(header);
root.add(timeline);
composerFrame.add(composer);
root.add(composerFrame);
root.add(status);
renderer.root.add(root);

const session = createSpikeSession();
for (const entry of session.timeline) {
  timeline.add(new TextRenderable(renderer, {
    id: `timeline-${entry.id}`,
    content: formatSpikeTimelineEntry(entry),
    height: 1,
  }));
}
timeline.scrollTo(timeline.scrollHeight);
composer.focus();

let burstSequence = 0;
renderer.keyInput.on('keypress', (key: KeyEvent) => {
  status.content = formatInputProbe('key', key.raw);
  if (key.name === 'f2') {
    timeline.focus();
    status.content = 'timeline focused: touchpad, wheel, arrows, PageUp/PageDown';
    return;
  }
  if (key.name === 'f3') {
    composer.focus();
    status.content = 'composer focused';
    return;
  }
  if (key.ctrl && key.name === 'd') {
    runDeltaBurst();
    return;
  }
  if (key.ctrl && key.name === 't') {
    appendTimelineBurst();
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

if (process.argv.includes('--smoke')) {
  renderer.once('frame', () => {
    setTimeout(() => renderer.destroy(), 50);
  });
}

function runDeltaBurst() {
  burstSequence += 1;
  const row = new TextRenderable(renderer, {
    id: `delta-burst-${burstSequence}`,
    content: 'assistant  ',
    height: 1,
  });
  timeline.add(row);
  let tick = 0;
  const timer = setInterval(() => {
    tick += 1;
    row.content = `assistant  delta burst ${burstSequence}: ${'▮'.repeat(tick % 40)}`;
    if (tick >= 400) {
      clearInterval(timer);
      row.content = `assistant  delta burst ${burstSequence}: completed (400 updates)`;
      status.content = 'delta burst completed';
    }
  }, 8);
}

function appendTimelineBurst() {
  burstSequence += 1;
  for (let index = 0; index < 250; index += 1) {
    timeline.add(new TextRenderable(renderer, {
      id: `row-burst-${burstSequence}-${index}`,
      content: `system     appended row ${index + 1}/250 · 宽字符 🙂`,
      height: 1,
    }));
  }
  status.content = 'appended 250 rows';
}
