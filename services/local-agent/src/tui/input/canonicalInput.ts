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
  | { type: 'cursor.left' }
  | { type: 'cursor.right' }
  | { type: 'cursor.up' }
  | { type: 'cursor.down' }
  | { type: 'cursor.line.start' }
  | { type: 'cursor.line.end' }
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

  if (key.leftArrow) return { type: 'cursor.left' };
  if (key.rightArrow) return { type: 'cursor.right' };
  if (key.upArrow) return { type: 'cursor.up' };
  if (key.downArrow) return { type: 'cursor.down' };
  if (key.home) return { type: 'cursor.line.start' };
  if (key.end) return { type: 'cursor.line.end' };
  if (key.backspace) return { type: 'text.delete.backward' };
  if (key.delete) return { type: 'text.delete.forward' };
  if (key.escape) return { type: 'escape' };
  if (key.tab) return { type: 'tab', shift: Boolean(key.shift) };
  if (key.return) return key.shift ? { type: 'newline' } : { type: 'submit' };

  if (isRawReturnInput(input)) return { type: 'submit' };
  if (isRawNewlineInput(input)) return { type: 'newline' };
  if (isRawDeleteForwardInput(input)) return { type: 'text.delete.forward' };
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
      return { type: 'cursor.line.start' };
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

function isRawHomeInput(input: string) {
  return input === '\x1b[H'
    || input === '[H'
    || input === '\x1b[1~'
    || input === '[1~'
    || input === '\x1b[7~'
    || input === '[7~';
}

function isRawEndInput(input: string) {
  return input === '\x1b[F'
    || input === '[F'
    || input === '\x1b[4~'
    || input === '[4~'
    || input === '\x1b[8~'
    || input === '[8~';
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
