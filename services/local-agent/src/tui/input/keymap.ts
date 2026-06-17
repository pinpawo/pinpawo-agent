import {
  isTextAreaNewlineInput,
} from './textareaModel';
import type { TuiKeyInput } from './keyInput';
import { isTerminalControlSequence } from './terminalInput';

export type { TuiKeyInput } from './keyInput';
export {
  createInitialTuiInputBufferState,
  isTerminalControlSequence,
  isTerminalControlSequencePrefix,
  normalizeTuiInputEvent,
  type NormalizedTuiInputEvent,
  type TuiInputBufferState,
} from './terminalInput';

export type TuiKeyContext = {
  ready: boolean;
  busy: boolean;
  hasPendingApproval: boolean;
  hasResumePicker: boolean;
};

export type TuiKeyAction =
  | { type: 'global.ctrl_c' }
  | { type: 'global.interrupt' }
  | { type: 'approval.previous' }
  | { type: 'approval.next' }
  | { type: 'approval.submit' }
  | { type: 'resume.previous' }
  | { type: 'resume.next' }
  | { type: 'resume.submit' }
  | { type: 'resume.dismiss' }
  | { type: 'composer.submit' }
  | { type: 'composer.clear' }
  | { type: 'composer.edit' }
  | { type: 'none' };

export function resolveTuiKeyAction(
  input: string,
  key: TuiKeyInput,
  context: TuiKeyContext,
): TuiKeyAction {
  const isReturn = isReturnKeyInput(input, key);
  const isNewline = isTextAreaNewlineInput(input, key);
  const isControlSequence = isTerminalControlSequence(input);

  if (key.ctrl && input === 'c') {
    return { type: 'global.ctrl_c' };
  }

  if (!context.ready) {
    return { type: 'none' };
  }

  if (context.hasResumePicker) {
    if (key.upArrow) return { type: 'resume.previous' };
    if (key.downArrow) return { type: 'resume.next' };
    if (isReturn) return { type: 'resume.submit' };
    if (key.escape) return { type: 'resume.dismiss' };
    return { type: 'none' };
  }

  if (context.hasPendingApproval) {
    if (key.upArrow) return { type: 'approval.previous' };
    if (key.downArrow) return { type: 'approval.next' };
    if (isNewline) return { type: 'composer.edit' };
    if (isReturn) return { type: 'approval.submit' };
    if (key.escape) return { type: 'global.interrupt' };
    if (key.tab || (key.shift && key.tab)) return { type: 'none' };
    if (isControlSequence) return { type: 'none' };
    return { type: 'composer.edit' };
  }

  if (context.busy) {
    if (key.escape) return { type: 'global.interrupt' };
    return { type: 'none' };
  }

  if (key.escape) return { type: 'composer.clear' };
  if (isNewline) return { type: 'composer.edit' };
  if (isReturn) return { type: 'composer.submit' };
  if (key.upArrow || key.downArrow) return { type: 'composer.edit' };
  if (key.tab || (key.shift && key.tab)) {
    return { type: 'none' };
  }
  if (isControlSequence) return { type: 'none' };

  return { type: 'composer.edit' };
}

function isReturnKeyInput(input: string, key: TuiKeyInput) {
  return (Boolean(key.return) && !key.shift) || input === '\r' || input === '\n' || input === '\r\n';
}
