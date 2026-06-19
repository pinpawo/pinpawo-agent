import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCommandPaletteModel,
  completeCommandPaletteInput,
  moveCommandPaletteSelection,
} from './commandPalette';

test('buildCommandPaletteModel opens for slash command prefixes', () => {
  const model = buildCommandPaletteModel({ text: '/', cursorOffset: 1 });

  assert.equal(model.open, true);
  assert.equal(model.query, '');
  assert.deepEqual(
    model.items.map((command) => command.name),
    ['new', 'studio', 'chat', 'policy', 'help', 'export', 'edit', 'resume', 'quit'],
  );
});

test('buildCommandPaletteModel filters command names and aliases', () => {
  const studio = buildCommandPaletteModel({ text: '/st', cursorOffset: 3 });
  assert.equal(studio.open, true);
  assert.deepEqual(studio.items.map((command) => command.name), ['studio']);

  const quitAlias = buildCommandPaletteModel({ text: '/exi', cursorOffset: 4 });
  assert.equal(quitAlias.open, true);
  assert.deepEqual(quitAlias.items.map((command) => command.name), ['quit']);
});

test('buildCommandPaletteModel stays closed outside the active slash prefix', () => {
  assert.equal(buildCommandPaletteModel({ text: 'hello', cursorOffset: 5 }).open, false);
  assert.equal(buildCommandPaletteModel({ text: '/studio task', cursorOffset: 12 }).open, false);
  assert.equal(buildCommandPaletteModel({ text: '/st', cursorOffset: 1 }).open, false);
  assert.equal(buildCommandPaletteModel({ text: '/Users/me', cursorOffset: 9 }).open, false);
});

test('command palette selection clamps and completes selected commands', () => {
  const model = buildCommandPaletteModel({ text: '/', cursorOffset: 1 }, 99);
  assert.equal(model.open, true);
  assert.equal(model.selectedIndex, model.items.length - 1);
  assert.equal(moveCommandPaletteSelection(model, -1), model.items.length - 2);

  const studio = buildCommandPaletteModel({ text: '/st', cursorOffset: 3 });
  assert.deepEqual(completeCommandPaletteInput(studio), {
    text: '/studio ',
    cursorOffset: '/studio '.length,
  });

  const chat = buildCommandPaletteModel({ text: '/ch', cursorOffset: 3 });
  assert.deepEqual(completeCommandPaletteInput(chat), {
    text: '/chat',
    cursorOffset: '/chat'.length,
  });

  const edit = buildCommandPaletteModel({ text: '/ed', cursorOffset: 3 });
  assert.deepEqual(completeCommandPaletteInput(edit), {
    text: '/edit ',
    cursorOffset: '/edit '.length,
  });
});
