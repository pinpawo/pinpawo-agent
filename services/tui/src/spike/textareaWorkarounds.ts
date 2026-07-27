import type { TextareaRenderable } from '@opentui/core';

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: 'grapheme',
});

/**
 * OpenTUI 0.4.5 removes the preceding newline together with the final
 * grapheme on a line. Keep this narrow and delete it after the native editor
 * fixes single-grapheme backspace behavior.
 */
export function installSingleGraphemeBackspaceWorkaround(
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
