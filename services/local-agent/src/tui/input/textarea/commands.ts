import type { CanonicalInputEvent } from '../canonicalInput';

export type TextAreaCommand =
  | { type: 'insert'; text: string }
  | { type: 'paste'; text: string }
  | { type: 'newline' }
  | { type: 'deleteBackward' }
  | { type: 'deleteForward' }
  | { type: 'deleteWordBackward' }
  | { type: 'deleteToLineStart' }
  | { type: 'deleteToLineEnd' }
  | { type: 'moveLeft' }
  | { type: 'moveRight' }
  | { type: 'moveUp' }
  | { type: 'moveDown' }
  | { type: 'moveLineStart' }
  | { type: 'moveLineEnd' }
  | { type: 'selectLeft' }
  | { type: 'selectRight' }
  | { type: 'selectUp' }
  | { type: 'selectDown' }
  | { type: 'selectLineStart' }
  | { type: 'selectLineEnd' }
  | { type: 'selectAll' };

export function toTextAreaCommand(event: CanonicalInputEvent): TextAreaCommand | null {
  switch (event.type) {
    case 'text.insert':
      return { type: 'insert', text: event.text };
    case 'text.paste':
      return { type: 'paste', text: event.text };
    case 'text.delete.backward':
      return { type: 'deleteBackward' };
    case 'text.delete.forward':
      return { type: 'deleteForward' };
    case 'text.delete.word.backward':
      return { type: 'deleteWordBackward' };
    case 'text.delete.to.line.start':
      return { type: 'deleteToLineStart' };
    case 'text.delete.to.line.end':
      return { type: 'deleteToLineEnd' };
    case 'cursor.left':
      return { type: 'moveLeft' };
    case 'cursor.right':
      return { type: 'moveRight' };
    case 'cursor.up':
      return { type: 'moveUp' };
    case 'cursor.down':
      return { type: 'moveDown' };
    case 'cursor.line.start':
      return { type: 'moveLineStart' };
    case 'cursor.line.end':
      return { type: 'moveLineEnd' };
    case 'newline':
      return { type: 'newline' };
    default:
      return null;
  }
}
