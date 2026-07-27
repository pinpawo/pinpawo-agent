import assert from 'node:assert/strict';
import test from 'node:test';
import { BoxRenderable, RGBA } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import {
  createCommandOverlayState,
  openCommandHelp,
  syncCommandPalette,
} from './commandOverlayModel';
import { CommandOverlayView } from './commandOverlayView';

test('command palette and help stay inside the fixed footer across resize', async (context) => {
  const setup = await createTestRenderer({
    width: 60,
    height: 24,
    screenMode: 'split-footer',
    footerHeight: 9,
  });
  context.after(() => setup.renderer.destroy());
  const root = new BoxRenderable(setup.renderer, {
    width: '100%',
    height: '100%',
    backgroundColor: RGBA.defaultBackground(),
  });
  const view = new CommandOverlayView(setup.renderer);
  root.add(view.frame);
  setup.renderer.root.add(root);

  const palette = syncCommandPalette(createCommandOverlayState(), {
    text: '/re',
    cursorOffset: 3,
    enabled: true,
  });
  view.render(palette, 60);
  await setup.flush();
  const initial = setup.captureCharFrame();
  assert.match(initial, /Commands · \/re/);
  assert.match(initial, /resume/);
  assert.equal(frameRows(initial).length, 9);

  setup.resize(32, 18);
  view.render(openCommandHelp(), 32);
  await setup.flush();
  const resized = setup.captureCharFrame();
  assert.match(resized, /Help/);
  assert.match(resized, /\/help/);
  assert.equal(frameRows(resized).length, 9);
  assert.ok(frameRows(resized).every((line) => line.length <= 32), resized);
});

function frameRows(frame: string) {
  const rows = frame.split('\n');
  if (rows.at(-1) === '') rows.pop();
  return rows;
}
