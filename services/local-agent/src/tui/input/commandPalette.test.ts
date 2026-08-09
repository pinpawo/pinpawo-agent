import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCommandPaletteModel,
  completeCommandPaletteInput,
  moveCommandPaletteSelection,
  submitCommandPaletteInput,
} from './commandPalette';

test('buildCommandPaletteModel opens for slash command prefixes', () => {
  const model = buildCommandPaletteModel({ text: '/', cursorOffset: 1 });

  assert.equal(model.open, true);
  assert.equal(model.query, '');
  assert.deepEqual(
    model.items.map((command) => command.name),
    ['new', 'model', 'policy', 'help', 'transcript', 'export', 'edit', 'continue', 'resume', 'quit'],
  );
});

test('buildCommandPaletteModel filters command names and aliases', () => {
  const policy = buildCommandPaletteModel({ text: '/po', cursorOffset: 3 });
  assert.equal(policy.open, true);
  assert.deepEqual(policy.items.map((command) => command.name), ['policy']);

  const quitAlias = buildCommandPaletteModel({ text: '/exi', cursorOffset: 4 });
  assert.equal(quitAlias.open, true);
  assert.deepEqual(quitAlias.items.map((command) => command.name), ['quit']);
});

test('buildCommandPaletteModel always offers explicit continuation', () => {
  const continuation = buildCommandPaletteModel({
    text: '/con',
    cursorOffset: 4,
  });
  assert.equal(continuation.open, true);
  assert.deepEqual(continuation.items.map((command) => command.name), ['continue']);
  assert.deepEqual(completeCommandPaletteInput(continuation), {
    text: '/continue ',
    cursorOffset: '/continue '.length,
  });
});

test('buildCommandPaletteModel stays closed outside the active slash prefix', () => {
  assert.equal(buildCommandPaletteModel({ text: 'hello', cursorOffset: 5 }).open, false);
  assert.equal(buildCommandPaletteModel({ text: '/export path', cursorOffset: 12 }).open, false);
  assert.equal(buildCommandPaletteModel({ text: '/ex', cursorOffset: 1 }).open, false);
  assert.equal(buildCommandPaletteModel({ text: '/Users/me', cursorOffset: 9 }).open, false);
});

test('command palette selection clamps and completes selected commands', () => {
  const model = buildCommandPaletteModel({ text: '/', cursorOffset: 1 }, 99);
  assert.equal(model.open, true);
  assert.equal(model.selectedIndex, model.items.length - 1);
  assert.equal(moveCommandPaletteSelection(model, -1), model.items.length - 2);

  const exportCommand = buildCommandPaletteModel({ text: '/ex', cursorOffset: 3 });
  assert.deepEqual(completeCommandPaletteInput(exportCommand), {
    text: '/export ',
    cursorOffset: '/export '.length,
  });

  // 无参命令补全后不追加空格。
  const transcript = buildCommandPaletteModel({ text: '/tr', cursorOffset: 3 });
  assert.deepEqual(completeCommandPaletteInput(transcript), {
    text: '/transcript',
    cursorOffset: '/transcript'.length,
  });

  const edit = buildCommandPaletteModel({ text: '/ed', cursorOffset: 3 });
  assert.deepEqual(completeCommandPaletteInput(edit), {
    text: '/edit ',
    cursorOffset: '/edit '.length,
  });
});

test('command palette submit runs the selected command without requiring tab completion', () => {
  const policy = buildCommandPaletteModel({ text: '/po', cursorOffset: 3 });
  assert.deepEqual(submitCommandPaletteInput(policy), {
    text: '/policy',
    cursorOffset: '/policy'.length,
  });

  const transcript = buildCommandPaletteModel({ text: '/tr', cursorOffset: 3 });
  assert.deepEqual(submitCommandPaletteInput(transcript), {
    text: '/transcript',
    cursorOffset: '/transcript'.length,
  });
});
