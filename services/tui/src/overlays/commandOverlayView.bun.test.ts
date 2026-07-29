import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BoxRenderable,
  RGBA,
  TextareaRenderable,
  TextRenderable,
} from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { syncComposerCursorForCommandOverlay } from '../input/composerCursor';
import { calculateComposerLayout } from '../layout/composerLayout';
import {
  closeCommandOverlay,
  createCommandOverlayState,
  openCommandHelp,
  syncCommandPalette,
} from './commandOverlayModel';
import { CommandOverlayView } from './commandOverlayView';

test('command palette stays above the composer while help owns the footer', async (context) => {
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
    flexDirection: 'column',
    backgroundColor: RGBA.defaultBackground(),
  });
  const header = new TextRenderable(setup.renderer, {
    content: 'PinPawo TUI v2',
    bg: RGBA.defaultBackground(),
    height: 1,
  });
  const live = new TextRenderable(setup.renderer, {
    content: 'live · idle',
    bg: RGBA.defaultBackground(),
    height: 1,
  });
  const composerFrame = new BoxRenderable(setup.renderer, {
    width: '100%',
    height: 5,
    border: true,
    paddingLeft: 1,
    paddingRight: 1,
    backgroundColor: RGBA.defaultBackground(),
  });
  const composer = new TextareaRenderable(setup.renderer, {
    width: '100%',
    height: '100%',
    backgroundColor: RGBA.defaultBackground(),
    focusedBackgroundColor: RGBA.defaultBackground(),
  });
  const status = new TextRenderable(setup.renderer, {
    content: 'connected\nin/out: 0/0',
    bg: RGBA.defaultBackground(),
    height: 2,
  });
  const view = new CommandOverlayView(setup.renderer);
  composerFrame.add(composer);
  root.add(header);
  root.add(live);
  root.add(composerFrame);
  root.add(status);
  root.add(view.frame);
  setup.renderer.root.add(root);
  composer.setText('/');
  composer.gotoBufferEnd();
  composer.focus();

  const palette = syncCommandPalette(createCommandOverlayState(), {
    text: '/',
    cursorOffset: 1,
    enabled: true,
  });
  const paletteLayout = calculateComposerLayout('/', 1, {
    commandPalette: true,
  });
  header.height = paletteLayout.headerHeight;
  live.height = paletteLayout.liveHeight;
  composerFrame.border = ['top'];
  composerFrame.height = paletteLayout.frameHeight;
  status.height = paletteLayout.statusHeight;
  syncComposerCursorForCommandOverlay(composer, palette);
  view.render(palette, 60);
  await setup.flush();
  const initial = setup.captureCharFrame();
  const initialRows = frameRows(initial);
  assert.match(initialRows[0] ?? '', /help/);
  assert.match(initialRows[4] ?? '', /model/);
  assert.ok(initialRows.slice(0, 5).every((line) => line.includes('/')));
  assert.match(initialRows.slice(5).join('\n'), /\//);
  assert.equal(composer.showCursor, true);
  assert.equal(initialRows.length, 9);

  status.content = 'connected · normal\nin/out: 20/10';
  composer.setText('');
  const normal = closeCommandOverlay();
  const normalLayout = calculateComposerLayout('', 1);
  header.height = normalLayout.headerHeight;
  live.height = normalLayout.liveHeight;
  composerFrame.border = true;
  composerFrame.height = normalLayout.frameHeight;
  status.height = normalLayout.statusHeight;
  syncComposerCursorForCommandOverlay(composer, normal);
  view.render(normal, 60);
  await setup.flush();
  const normalRows = frameRows(setup.captureCharFrame());
  assert.equal(normalRows.length, 9);
  assert.equal(
    normalRows.filter((row) => row.includes('connected · normal')).length,
    1,
  );
  assert.equal(
    normalRows.filter((row) => row.includes('in/out: 20/10')).length,
    1,
  );
  assert.doesNotMatch(normalRows.join('\n'), /in\/out: 0\/0/);

  setup.resize(32, 18);
  const help = openCommandHelp();
  syncComposerCursorForCommandOverlay(composer, help);
  view.render(help, 32);
  await setup.flush();
  const resized = setup.captureCharFrame();
  assert.match(resized, /Help/);
  assert.match(resized, /\/help/);
  assert.equal(composer.showCursor, false);
  assert.equal(frameRows(resized).length, 9);
  assert.ok(frameRows(resized).every((line) => line.length <= 32), resized);
});

function frameRows(frame: string) {
  const rows = frame.split('\n');
  if (rows.at(-1) === '') rows.pop();
  return rows;
}
