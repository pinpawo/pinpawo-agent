import type { CanonicalInputEvent } from './canonicalInput';

export type { TuiKeyInput } from './keyInput';
export {
  toCanonicalInputEvent,
  type CanonicalInputEvent,
} from './canonicalInput';
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
  event: CanonicalInputEvent,
  context: TuiKeyContext,
): TuiKeyAction {
  const isReturn = event.type === 'submit';
  const isNewline = event.type === 'newline';
  const isControlSequence = event.type === 'unknown.control';

  if (event.type === 'interrupt') {
    return { type: 'global.ctrl_c' };
  }

  if (!context.ready) {
    return { type: 'none' };
  }

  if (context.hasResumePicker) {
    if (event.type === 'cursor.up') return { type: 'resume.previous' };
    if (event.type === 'cursor.down') return { type: 'resume.next' };
    if (isReturn) return { type: 'resume.submit' };
    if (event.type === 'escape') return { type: 'resume.dismiss' };
    return { type: 'none' };
  }

  if (context.hasPendingApproval) {
    if (event.type === 'cursor.up') return { type: 'approval.previous' };
    if (event.type === 'cursor.down') return { type: 'approval.next' };
    if (isNewline) return { type: 'composer.edit' };
    if (isReturn) return { type: 'approval.submit' };
    if (event.type === 'escape') return { type: 'global.interrupt' };
    if (event.type === 'tab') return { type: 'none' };
    if (isControlSequence) return { type: 'none' };
    if (event.type === 'noop') return { type: 'none' };
    return { type: 'composer.edit' };
  }

  if (context.busy) {
    if (event.type === 'escape') return { type: 'global.interrupt' };
    return { type: 'none' };
  }

  if (event.type === 'escape') return { type: 'composer.clear' };
  if (isNewline) return { type: 'composer.edit' };
  if (isReturn) return { type: 'composer.submit' };
  if (event.type === 'cursor.up' || event.type === 'cursor.down') return { type: 'composer.edit' };
  if (event.type === 'tab') return { type: 'none' };
  if (isControlSequence) return { type: 'none' };
  if (event.type === 'noop') return { type: 'none' };

  return { type: 'composer.edit' };
}
