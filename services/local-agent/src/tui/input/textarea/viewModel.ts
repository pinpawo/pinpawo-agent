import { wrapTextAreaRows } from './layout';
import {
  renderTextAreaRows,
  type TextAreaRenderSegment,
} from './renderModel';
import type { TextAreaSelection } from './selection';
import { segmentTextAreaText } from './textSegments';

export type TextAreaViewRow = {
  before: string;
  cursor: string | null;
  after: string;
  dim: boolean;
  dimAfterCursor: boolean;
  segments?: TextAreaRenderSegment[];
};

export type TextAreaViewModel = {
  rows: TextAreaViewRow[];
};

export function buildTextAreaViewModel(options: {
  text: string;
  cursorOffset: number;
  placeholder?: string;
  focused?: boolean;
  width?: number;
  selection?: TextAreaSelection;
}): TextAreaViewModel {
  const text = options.text;
  const placeholder = options.placeholder ?? '';
  const focused = options.focused ?? true;
  const width = Math.max(1, options.width ?? 60);

  if (!focused) {
    return {
      rows: wrapTextAreaRows(text || placeholder, width).map((row) => ({
        before: row.text || ' ',
        cursor: null,
        after: '',
        dim: true,
        dimAfterCursor: false,
      })),
    };
  }

  if (!text) {
    return { rows: [buildEmptyTextAreaViewRow(placeholder)] };
  }

  return {
    rows: renderTextAreaRows({
      text,
      cursorOffset: options.cursorOffset,
      selection: options.selection,
    }, width).map((row) => ({
      before: row.before,
      cursor: row.cursor,
      after: row.after,
      dim: false,
      dimAfterCursor: false,
      ...(row.segments ? { segments: row.segments } : {}),
    })),
  };
}

function buildEmptyTextAreaViewRow(placeholder: string): TextAreaViewRow {
  const [cursorSegment] = segmentTextAreaText(placeholder);
  if (!cursorSegment) {
    return {
      before: '',
      cursor: ' ',
      after: '',
      dim: false,
      dimAfterCursor: false,
    };
  }

  return {
    before: '',
    cursor: cursorSegment.text,
    after: placeholder.slice(cursorSegment.end),
    dim: false,
    dimAfterCursor: true,
  };
}
