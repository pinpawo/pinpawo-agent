import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCommandOverlayState,
  openCommandHelp,
  syncCommandPalette,
} from '../overlays/commandOverlayModel';
import { syncComposerCursorForCommandOverlay } from './composerCursor';

test('composer cursor stays visible for filtering and hides only behind help', () => {
  const composer = { showCursor: true };

  const palette = syncCommandPalette(createCommandOverlayState(), {
    text: '/',
    cursorOffset: 1,
    enabled: true,
  });
  syncComposerCursorForCommandOverlay(composer, palette);
  assert.equal(composer.showCursor, true);

  syncComposerCursorForCommandOverlay(composer, openCommandHelp());
  assert.equal(composer.showCursor, false);

  syncComposerCursorForCommandOverlay(composer, createCommandOverlayState());
  assert.equal(composer.showCursor, true);
});
