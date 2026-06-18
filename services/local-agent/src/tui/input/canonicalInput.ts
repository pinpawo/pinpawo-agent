import type { TuiKeyInput } from './keyInput';
import { isTerminalControlSequence } from './terminalInput';
import type { NormalizedTuiInputEvent } from './terminalInput';

export type CanonicalInputEvent =
  | { type: 'text.insert'; text: string }
  | { type: 'text.paste'; text: string }
  | { type: 'text.delete.backward' }
  | { type: 'text.delete.forward' }
  | { type: 'text.delete.word.backward' }
  | { type: 'text.delete.to.line.start' }
  | { type: 'text.delete.to.line.end' }
  | { type: 'edit.undo' }
  | { type: 'edit.redo' }
  | { type: 'edit.select.all' }
  | { type: 'cursor.left' }
  | { type: 'cursor.right' }
  | { type: 'cursor.up' }
  | { type: 'cursor.down' }
  | { type: 'cursor.line.start' }
  | { type: 'cursor.line.end' }
  | { type: 'selection.left' }
  | { type: 'selection.right' }
  | { type: 'selection.up' }
  | { type: 'selection.down' }
  | { type: 'selection.line.start' }
  | { type: 'selection.line.end' }
  | { type: 'submit' }
  | { type: 'newline' }
  | { type: 'escape' }
  | { type: 'tab'; shift: boolean }
  | { type: 'interrupt' }
  | { type: 'unknown.control'; raw: string }
  | { type: 'noop' };

export function toCanonicalInputEvent(
  event: NormalizedTuiInputEvent,
): CanonicalInputEvent {
  const { input, key } = event;
  const controlEvent = toCanonicalControlKey(input, key);
  if (controlEvent) return controlEvent;

  if (key.leftArrow) return key.shift ? { type: 'selection.left' } : { type: 'cursor.left' };
  if (key.rightArrow) return key.shift ? { type: 'selection.right' } : { type: 'cursor.right' };
  if (key.upArrow) return key.shift ? { type: 'selection.up' } : { type: 'cursor.up' };
  if (key.downArrow) return key.shift ? { type: 'selection.down' } : { type: 'cursor.down' };
  if (key.home) return key.shift ? { type: 'selection.line.start' } : { type: 'cursor.line.start' };
  if (key.end) return key.shift ? { type: 'selection.line.end' } : { type: 'cursor.line.end' };
  if (key.backspace) return { type: 'text.delete.backward' };
  // Ink parses the Backspace key (\x7f) as `key.delete` with an empty input
  // (see ink/build/parse-keypress.js + hooks/use-input.js), so a bare
  // `key.delete` means Backspace, not the forward-delete key. The real
  // forward-delete key arrives as a raw `\x1b[3~` sequence handled below.
  if (key.delete && !isRawDeleteForwardInput(input)) {
    return { type: 'text.delete.backward' };
  }
  if (key.delete) return { type: 'text.delete.forward' };
  if (key.escape) return { type: 'escape' };
  if (key.tab) return { type: 'tab', shift: Boolean(key.shift) };
  if (key.return) return key.shift ? { type: 'newline' } : { type: 'submit' };

  if (isRawReturnInput(input)) return { type: 'submit' };
  if (isRawNewlineInput(input)) return { type: 'newline' };
  if (isRawDeleteForwardInput(input)) return { type: 'text.delete.forward' };
  if (isRawShiftCursorInput(input, 'D')) return { type: 'selection.left' };
  if (isRawShiftCursorInput(input, 'C')) return { type: 'selection.right' };
  if (isRawShiftCursorInput(input, 'A')) return { type: 'selection.up' };
  if (isRawShiftCursorInput(input, 'B')) return { type: 'selection.down' };
  if (isRawShiftHomeInput(input)) return { type: 'selection.line.start' };
  if (isRawShiftEndInput(input)) return { type: 'selection.line.end' };
  if (isRawCursorInput(input, 'D')) return { type: 'cursor.left' };
  if (isRawCursorInput(input, 'C')) return { type: 'cursor.right' };
  if (isRawCursorInput(input, 'A')) return { type: 'cursor.up' };
  if (isRawCursorInput(input, 'B')) return { type: 'cursor.down' };
  if (isRawHomeInput(input)) return { type: 'cursor.line.start' };
  if (isRawEndInput(input)) return { type: 'cursor.line.end' };
  if (isBracketedPasteInput(input)) {
    return { type: 'text.paste', text: normalizeTextInput(input) };
  }
  if (isTerminalControlSequence(input)) {
    return { type: 'unknown.control', raw: input };
  }

  const text = normalizeTextInput(input);
  return text ? { type: 'text.insert', text } : { type: 'noop' };
}

function toCanonicalControlKey(
  input: string,
  key: TuiKeyInput,
): CanonicalInputEvent | null {
  if (!key.ctrl) return null;

  switch (input) {
    case 'a':
      return { type: 'edit.select.all' };
    case 'c':
      return { type: 'interrupt' };
    case 'e':
      return { type: 'cursor.line.end' };
    case 'k':
      return { type: 'text.delete.to.line.end' };
    case 'u':
      return { type: 'text.delete.to.line.start' };
    case 'w':
      return { type: 'text.delete.word.backward' };
    case 'y':
      return { type: 'edit.redo' };
    case 'z':
      return key.shift ? { type: 'edit.redo' } : { type: 'edit.undo' };
    case 'Z':
      return { type: 'edit.redo' };
    default:
      return { type: 'noop' };
  }
}

function isRawReturnInput(input: string) {
  return input === '\r' || input === '\n' || input === '\r\n';
}

function isRawNewlineInput(input: string) {
  return input === '\x1b[13;2u'
    || input === '\x1b[13;2~'
    || input === '\x1b[27;2;13~'
    || input === '[13;2u'
    || input === '[13;2~'
    || input === '[27;2;13~';
}

function isRawDeleteForwardInput(input: string) {
  return /^(?:\x1b)?\[3(?:;\d+)*~$/.test(input);
}

function isRawCursorInput(input: string, code: 'A' | 'B' | 'C' | 'D') {
  return input === `\x1b[${code}` || input === `[${code}`;
}

function isRawShiftCursorInput(input: string, code: 'A' | 'B' | 'C' | 'D') {
  return input === `\x1b[1;2${code}` || input === `[1;2${code}`;
}

function isRawHomeInput(input: string) {
  return input === '\x1b[H'
    || input === '[H'
    || input === '\x1b[1~'
    || input === '[1~'
    || input === '\x1b[7~'
    || input === '[7~';
}

function isRawShiftHomeInput(input: string) {
  return /^(?:\x1b)?\[(?:1;2H|7;2~)$/.test(input);
}

function isRawEndInput(input: string) {
  return input === '\x1b[F'
    || input === '[F'
    || input === '\x1b[4~'
    || input === '[4~'
    || input === '\x1b[8~'
    || input === '[8~';
}

function isRawShiftEndInput(input: string) {
  return /^(?:\x1b)?\[(?:1;2F|8;2~)$/.test(input);
}

function isBracketedPasteInput(input: string) {
  return /(?:\x1b)?\[200~/.test(input) || /(?:\x1b)?\[201~/.test(input);
}

function normalizeTextInput(input: string) {
  return input
    .replace(/(?:\x1b)?\[200~/g, '')
    .replace(/(?:\x1b)?\[201~/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}
