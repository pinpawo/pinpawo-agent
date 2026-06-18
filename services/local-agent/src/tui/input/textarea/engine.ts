import {
  toCanonicalInputEvent,
  type CanonicalInputEvent,
} from '../canonicalInput';
import type { TuiKeyInput } from '../keyInput';
import {
  toTextAreaCommand,
  type TextAreaCommand,
} from './commands';
import {
  findTextAreaOffsetAtVisualColumn,
  measureTextAreaLayout,
} from './layout';
import {
  createTextAreaSelectAllSelection,
  getTextAreaSelectionRange,
  normalizeTextAreaSelection,
  type TextAreaSelection,
} from './selection';

const MAX_TEXTAREA_EDIT_HISTORY_ITEMS = 100;

export type TextAreaEditHistoryEntry = {
  text: string;
  cursorOffset: number;
  selection?: TextAreaSelection;
};

export type TextAreaEditHistory = {
  undo: TextAreaEditHistoryEntry[];
  redo: TextAreaEditHistoryEntry[];
};

export type TextAreaModel = {
  text: string;
  cursorOffset: number;
  selection?: TextAreaSelection;
  editHistory?: TextAreaEditHistory;
  preferredColumn?: number;
};

export function createTextAreaModel(
  text = '',
  cursorOffset = text.length,
  selection?: TextAreaSelection,
  editHistory?: TextAreaEditHistory,
  preferredColumn?: number,
): TextAreaModel {
  const nextSelection = normalizeTextAreaSelection(selection, text);
  const nextEditHistory = normalizeTextAreaEditHistory(editHistory);
  const nextPreferredColumn = normalizePreferredColumn(preferredColumn);
  return {
    text,
    cursorOffset: clampCursor(cursorOffset, text),
    ...(nextSelection ? { selection: nextSelection } : {}),
    ...(nextEditHistory ? { editHistory: nextEditHistory } : {}),
    ...(nextPreferredColumn !== undefined ? { preferredColumn: nextPreferredColumn } : {}),
  };
}

export function applyTextAreaInput(
  input: string,
  key: TuiKeyInput,
  state: TextAreaModel,
  options: { width?: number } = {},
): TextAreaModel {
  return applyTextAreaInputEvent(toCanonicalInputEvent({ input, key }), state, options);
}

export function applyTextAreaInputEvent(
  event: CanonicalInputEvent,
  state: TextAreaModel,
  options: { width?: number } = {},
): TextAreaModel {
  const command = toTextAreaCommand(event);
  if (!command) {
    return createTextAreaModel(
      state.text,
      state.cursorOffset,
      state.selection,
      state.editHistory,
      state.preferredColumn,
    );
  }
  return applyTextAreaCommand(command, state, options);
}

export function applyTextAreaCommand(
  command: TextAreaCommand,
  state: TextAreaModel,
  options: { width?: number } = {},
): TextAreaModel {
  const text = state.text;
  const cursorOffset = clampCursor(state.cursorOffset, text);
  const selectionRange = getTextAreaSelectionRange(state.selection, text);
  const width = options.width ?? Number.MAX_SAFE_INTEGER;

  switch (command.type) {
    case 'insert':
    case 'paste':
      if (selectionRange) {
        return replaceRange(
          state,
          selectionRange.start,
          selectionRange.end,
          command.text,
          selectionRange.start + command.text.length,
        );
      }
      return replaceRange(state, cursorOffset, cursorOffset, command.text, cursorOffset + command.text.length);
    case 'deleteBackward':
      if (selectionRange) return replaceRange(state, selectionRange.start, selectionRange.end, '', selectionRange.start);
      if (cursorOffset === 0) return createTextAreaModel(text, cursorOffset, undefined, state.editHistory);
      return replaceRange(state, cursorOffset - 1, cursorOffset, '', cursorOffset - 1);
    case 'deleteForward':
      if (selectionRange) return replaceRange(state, selectionRange.start, selectionRange.end, '', selectionRange.start);
      if (cursorOffset === text.length) return createTextAreaModel(text, cursorOffset, undefined, state.editHistory);
      return replaceRange(state, cursorOffset, cursorOffset + 1, '', cursorOffset);
    case 'deleteWordBackward': {
      if (selectionRange) return replaceRange(state, selectionRange.start, selectionRange.end, '', selectionRange.start);
      const wordStart = findPreviousWordStart(text, cursorOffset);
      return replaceRange(state, wordStart, cursorOffset, '', wordStart);
    }
    case 'deleteToLineStart': {
      if (selectionRange) return replaceRange(state, selectionRange.start, selectionRange.end, '', selectionRange.start);
      const lineStart = findLogicalLineStart(text, cursorOffset);
      return replaceRange(state, lineStart, cursorOffset, '', lineStart);
    }
    case 'deleteToLineEnd':
      if (selectionRange) return replaceRange(state, selectionRange.start, selectionRange.end, '', selectionRange.start);
      return replaceRange(state, cursorOffset, findLogicalLineEnd(text, cursorOffset), '', cursorOffset);
    case 'moveLeft':
      return createTextAreaModel(text, cursorOffset - 1, undefined, state.editHistory);
    case 'moveRight':
      return createTextAreaModel(text, cursorOffset + 1, undefined, state.editHistory);
    case 'moveUp':
      return moveCursorVertically(text, state, cursorOffset, width, -1);
    case 'moveDown':
      return moveCursorVertically(text, state, cursorOffset, width, 1);
    case 'moveLineStart':
      return createTextAreaModel(text, findLogicalLineStart(text, cursorOffset), undefined, state.editHistory);
    case 'moveLineEnd':
      return createTextAreaModel(text, findLogicalLineEnd(text, cursorOffset), undefined, state.editHistory);
    case 'selectLeft':
      return selectToOffset(text, state, cursorOffset - 1);
    case 'selectRight':
      return selectToOffset(text, state, cursorOffset + 1);
    case 'selectUp':
      return selectVertically(text, state, cursorOffset, width, -1);
    case 'selectDown':
      return selectVertically(text, state, cursorOffset, width, 1);
    case 'selectLineStart':
      return selectToOffset(text, state, findLogicalLineStart(text, cursorOffset));
    case 'selectLineEnd':
      return selectToOffset(text, state, findLogicalLineEnd(text, cursorOffset));
    case 'newline':
      if (selectionRange) return replaceRange(state, selectionRange.start, selectionRange.end, '\n', selectionRange.start + 1);
      return replaceRange(state, cursorOffset, cursorOffset, '\n', cursorOffset + 1);
    case 'selectAll':
      return createTextAreaModel(text, text.length, createTextAreaSelectAllSelection(text), state.editHistory);
    case 'undo':
      return restoreTextAreaEditHistory(state, 'undo');
    case 'redo':
      return restoreTextAreaEditHistory(state, 'redo');
  }
}

function replaceRange(
  state: TextAreaModel,
  start: number,
  end: number,
  replacement: string,
  cursorOffset: number,
): TextAreaModel {
  const text = state.text;
  const nextText = text.slice(0, start) + replacement + text.slice(end);
  return recordTextAreaEdit(state, createTextAreaModel(nextText, cursorOffset));
}

function selectToOffset(
  text: string,
  state: TextAreaModel,
  focusOffset: number,
): TextAreaModel {
  const boundedFocusOffset = clampCursor(focusOffset, text);
  const anchorOffset = state.selection
    ? clampCursor(state.selection.anchorOffset, text)
    : clampCursor(state.cursorOffset, text);
  return createTextAreaModel(text, boundedFocusOffset, {
    anchorOffset,
    focusOffset: boundedFocusOffset,
  }, state.editHistory);
}

function selectVertically(
  text: string,
  state: TextAreaModel,
  cursorOffset: number,
  width: number,
  direction: -1 | 1,
): TextAreaModel {
  const movement = getVerticalCursorMovement(text, state, cursorOffset, width, direction);
  const next = selectToOffset(text, state, movement.cursorOffset);
  return createTextAreaModel(
    next.text,
    next.cursorOffset,
    next.selection,
    next.editHistory,
    movement.preferredColumn,
  );
}

function recordTextAreaEdit(previous: TextAreaModel, next: TextAreaModel): TextAreaModel {
  if (previous.text === next.text) {
    return createTextAreaModel(next.text, next.cursorOffset, next.selection, previous.editHistory);
  }

  const history = normalizeTextAreaEditHistory(previous.editHistory) ?? { undo: [], redo: [] };
  return createTextAreaModel(next.text, next.cursorOffset, next.selection, {
    undo: trimTextAreaEditHistory([...history.undo, snapshotTextAreaModel(previous)]),
    redo: [],
  });
}

function restoreTextAreaEditHistory(
  state: TextAreaModel,
  direction: 'undo' | 'redo',
): TextAreaModel {
  const history = normalizeTextAreaEditHistory(state.editHistory) ?? { undo: [], redo: [] };
  const source = history[direction];
  const entry = source[source.length - 1];
  if (!entry) return createTextAreaModel(state.text, state.cursorOffset, state.selection, history);

  const current = snapshotTextAreaModel(state);
  const nextHistory = direction === 'undo'
    ? {
        undo: history.undo.slice(0, -1),
        redo: trimTextAreaEditHistory([...history.redo, current]),
      }
    : {
        undo: trimTextAreaEditHistory([...history.undo, current]),
        redo: history.redo.slice(0, -1),
      };

  return createTextAreaModel(entry.text, entry.cursorOffset, entry.selection, nextHistory);
}

function normalizeTextAreaEditHistory(
  history: TextAreaEditHistory | null | undefined,
): TextAreaEditHistory | undefined {
  if (!history) return undefined;
  const undoEntries = Array.isArray(history.undo) ? history.undo : [];
  const redoEntries = Array.isArray(history.redo) ? history.redo : [];
  const undo = trimTextAreaEditHistory(undoEntries.map(normalizeTextAreaEditHistoryEntry).filter(isTextAreaEditHistoryEntry));
  const redo = trimTextAreaEditHistory(redoEntries.map(normalizeTextAreaEditHistoryEntry).filter(isTextAreaEditHistoryEntry));
  return undo.length || redo.length ? { undo, redo } : undefined;
}

function normalizeTextAreaEditHistoryEntry(
  entry: TextAreaEditHistoryEntry,
): TextAreaEditHistoryEntry | null {
  if (typeof entry.text !== 'string') return null;
  const selection = normalizeTextAreaSelection(entry.selection, entry.text);
  return {
    text: entry.text,
    cursorOffset: clampCursor(entry.cursorOffset, entry.text),
    ...(selection ? { selection } : {}),
  };
}

function isTextAreaEditHistoryEntry(
  entry: TextAreaEditHistoryEntry | null,
): entry is TextAreaEditHistoryEntry {
  return entry !== null;
}

function trimTextAreaEditHistory(entries: TextAreaEditHistoryEntry[]) {
  return entries.length > MAX_TEXTAREA_EDIT_HISTORY_ITEMS
    ? entries.slice(entries.length - MAX_TEXTAREA_EDIT_HISTORY_ITEMS)
    : entries;
}

function snapshotTextAreaModel(model: TextAreaModel): TextAreaEditHistoryEntry {
  const normalized = createTextAreaModel(model.text, model.cursorOffset, model.selection);
  return {
    text: normalized.text,
    cursorOffset: normalized.cursorOffset,
    ...(normalized.selection ? { selection: normalized.selection } : {}),
  };
}

function moveCursorVertically(
  text: string,
  state: TextAreaModel,
  cursorOffset: number,
  width: number,
  direction: -1 | 1,
): TextAreaModel {
  const movement = getVerticalCursorMovement(text, state, cursorOffset, width, direction);
  return createTextAreaModel(
    text,
    movement.cursorOffset,
    undefined,
    state.editHistory,
    movement.preferredColumn,
  );
}

function getVerticalCursorMovement(
  text: string,
  state: TextAreaModel,
  cursorOffset: number,
  width: number,
  direction: -1 | 1,
) {
  const layout = measureTextAreaLayout({ text, cursorOffset }, width);
  const preferredColumn = state.preferredColumn ?? layout.cursor.column;
  const targetRowIndex = Math.max(
    0,
    Math.min(layout.rows.length - 1, layout.cursor.rowIndex + direction),
  );
  const targetRow = layout.rows[targetRowIndex] ?? layout.rows[layout.cursor.rowIndex]!;
  return {
    cursorOffset: findTextAreaOffsetAtVisualColumn(targetRow, text, preferredColumn),
    preferredColumn,
  };
}

function findLogicalLineStart(text: string, cursorOffset: number) {
  return text.lastIndexOf('\n', Math.max(0, cursorOffset - 1)) + 1;
}

function findLogicalLineEnd(text: string, cursorOffset: number) {
  const nextNewline = text.indexOf('\n', cursorOffset);
  return nextNewline === -1 ? text.length : nextNewline;
}

function findPreviousWordStart(text: string, cursorOffset: number) {
  let start = cursorOffset;
  while (start > 0 && /\s/.test(text[start - 1]!)) start -= 1;
  while (start > 0 && !/\s/.test(text[start - 1]!)) start -= 1;
  return start;
}

function clampCursor(cursorOffset: number, text: string) {
  return Math.max(0, Math.min(text.length, cursorOffset));
}

function normalizePreferredColumn(preferredColumn: number | null | undefined) {
  return typeof preferredColumn === 'number' && Number.isFinite(preferredColumn)
    ? Math.max(0, preferredColumn)
    : undefined;
}
