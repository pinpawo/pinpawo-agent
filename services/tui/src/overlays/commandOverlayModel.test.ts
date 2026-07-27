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
  assert.deepEqual(
    state.phase === 'palette'
      ? state.items.map((command) => command.name)
      : [],
    ['resume'],
  );
  assert.equal(commandCompletion(state), '/resume');

  state = syncCommandPalette(state, {
    text: '/stu',
    cursorOffset: 4,
    enabled: true,
  });
  assert.equal(commandCompletion(state), '/studio ');

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
  assert.equal(resolveCommandOverlayKey(state, key('q')), 'close');
  for (const line of second.content.split('\n')) {
    assert.ok(stringWidth(line) <= 28, line);
  }
});

function key(name: string, ctrl = false, shift = false) {
  return { name, ctrl, shift };
}
