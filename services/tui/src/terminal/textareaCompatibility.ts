import type { TextareaRenderable } from '@opentui/core';

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: 'grapheme',
});

/**
 * Keep OpenTUI 0.4.5 editor compatibility fixes in one narrow boundary so
 * they can be removed when the native editor catches up.
 */
export function installTextareaWorkarounds(
  textarea: TextareaRenderable,
) {
  installSingleGraphemeBackspaceWorkaround(textarea);
  installReverseSelectionCollapseWorkaround(textarea);
}

function installSingleGraphemeBackspaceWorkaround(
  textarea: TextareaRenderable,
) {
  const nativeDeleteCharBackward = textarea.deleteCharBackward.bind(textarea);

  textarea.deleteCharBackward = () => {
    if (!textarea.hasSelection()) {
      const cursor = textarea.logicalCursor;
      const lines = textarea.plainText.split('\n');
      const line = lines[cursor.row] ?? '';
      const graphemes = [...graphemeSegmenter.segment(line)];
      if (graphemes.length === 1 && cursor.col > 0) {
        lines[cursor.row] = '';
        textarea.replaceText(lines.join('\n'));
        textarea.setCursor(cursor.row, 0);
        return true;
      }
    }
    return nativeDeleteCharBackward();
  };
}

/**
 * OpenTUI 0.4.5 collapses a reverse selection one character before its end
 * when the user presses Right. The selection end is already exclusive, so
 * preserve normal editor behavior by moving directly to that offset.
 */
function installReverseSelectionCollapseWorkaround(
  textarea: TextareaRenderable,
) {
  const nativeMoveCursorRight = textarea.moveCursorRight.bind(textarea);

  textarea.moveCursorRight = (options) => {
    const selection = options?.select ? null : textarea.getSelection();
    if (selection && textarea.cursorOffset === selection.start) {
      textarea.editBuffer.setCursorByOffset(selection.end);
      textarea.clearSelection();
      return true;
    }
    return nativeMoveCursorRight(options);
  };
}
