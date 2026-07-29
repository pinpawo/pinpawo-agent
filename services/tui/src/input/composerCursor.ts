import type { TextareaRenderable } from '@opentui/core';
import type { CommandOverlayState } from '../overlays/commandOverlayModel';

export function syncComposerCursorForCommandOverlay(
  composer: Pick<TextareaRenderable, 'showCursor'>,
  commandOverlay: CommandOverlayState,
) {
  composer.showCursor = commandOverlay.phase !== 'help';
}
