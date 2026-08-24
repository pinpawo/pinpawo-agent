import assert from 'node:assert/strict';
import test from 'node:test';
import stringWidth from 'string-width';
import {
  buildCommandOverlayViewModel,
  commandCompletion,
  createCommandOverlayState,
  moveCommandSelection,
  openCommandHelp,
  pageCommandHelp,
  resolveCommandOverlayKey,
  syncCommandPalette,
} from './commandOverlayModel';

test('command palette follows a slash token at the composer cursor', () => {
  let state = syncCommandPalette(createCommandOverlayState(), {
    text: '/',
    cursorOffset: 1,
    enabled: true,
  });
  assert.equal(state.phase, 'palette');
  assert.equal(commandCompletion(state), '/help');

  state = syncCommandPalette(state, {
    text: '/re',
    cursorOffset: 3,
    enabled: true,
  });
  // `/refresh` (#654) 也以 re 开头,按注册表顺序排在 resume 之前;
  // policy 是靠别名匹配进来的。
  assert.deepEqual(
    state.phase === 'palette'
      ? state.items.map((command) => command.name)
      : [],
    ['refresh', 'resume', 'policy'],
  );
  assert.equal(commandCompletion(state), '/refresh');

  state = syncCommandPalette(state, {
    text: '/review',
    cursorOffset: 7,
    enabled: true,
  });
  assert.equal(commandCompletion(state), '/policy');

  state = syncCommandPalette(state, {
    text: '/stu',
    cursorOffset: 4,
    enabled: true,
  });
  assert.equal(commandCompletion(state), null);

  state = syncCommandPalette(state, {
    text: '/tra',
    cursorOffset: 4,
    enabled: true,
  });
  assert.equal(commandCompletion(state), '/transcript');

  state = syncCommandPalette(state, {
    text: '/exp',
    cursorOffset: 4,
    enabled: true,
  });
  assert.equal(commandCompletion(state), '/export ');

  state = syncCommandPalette(state, {
    text: '/re',
    cursorOffset: 3,
    enabled: false,
  });
  assert.equal(state.phase, 'closed');
});

test('command palette navigation clamps and yields ordinary editing keys', () => {
  let state = syncCommandPalette(createCommandOverlayState(), {
    text: '/',
    cursorOffset: 1,
    enabled: true,
  });
  state = moveCommandSelection(state, 1);
  assert.equal(commandCompletion(state), '/new');
  assert.equal(resolveCommandOverlayKey(state, key('down')), 'next');
  assert.equal(resolveCommandOverlayKey(state, key('tab')), 'complete');
  assert.equal(resolveCommandOverlayKey(state, key('return')), 'submit');
  assert.equal(resolveCommandOverlayKey(state, key('x')), null);

  state = moveCommandSelection(state, 1);
  const palette = state.phase === 'palette'
    ? buildCommandOverlayViewModel(state, 80)
    : null;
  assert.equal(palette?.kind, 'palette');
  assert.equal(palette?.content.split('\n').length, 5);
  assert.match(palette?.content ?? '', /› \/chat/);

  state = syncCommandPalette(state, {
    text: '/help ',
    cursorOffset: 6,
    enabled: true,
  });
  assert.equal(state.phase, 'closed');
});

test('command help pages and remains terminal-width safe', () => {
  let state = openCommandHelp();
  assert.equal(state.phase, 'help');
  if (state.phase !== 'help') return;
  const first = buildCommandOverlayViewModel(state, 32);
  state = pageCommandHelp(state, 1);
  assert.equal(state.phase, 'help');
  if (state.phase !== 'help') return;
  const second = buildCommandOverlayViewModel(state, 32);
  assert.notEqual(second.content, first.content);
  let last = openCommandHelp();
  for (let index = 0; index < 4; index += 1) {
    last = pageCommandHelp(last, 1);
  }
  assert.equal(last.phase, 'help');
  if (last.phase !== 'help') return;
  assert.match(
    buildCommandOverlayViewModel(last, 80).content,
    /Recall prompts/,
  );
  assert.match(
    buildCommandOverlayViewModel(last, 80).content,
    /@path — Complete workspace files in chat/,
  );
  assert.match(
    buildCommandOverlayViewModel(last, 80).content,
    /Shift\+Enter \/ Ctrl\+J — Insert a newline/,
  );
  const secondHelpPage = pageCommandHelp(
    openCommandHelp(),
    1,
  );
  assert.match(
    secondHelpPage.phase === 'help'
      ? buildCommandOverlayViewModel(secondHelpPage, 100).content
      : '',
    /\/refresh/,
  );
  assert.equal(resolveCommandOverlayKey(state, key('q')), 'close');
  for (const line of second.content.split('\n')) {
    assert.ok(stringWidth(line) <= 28, line);
  }
});

function key(name: string, ctrl = false, shift = false) {
  return { name, ctrl, shift };
}
