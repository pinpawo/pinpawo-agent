import {
  isTextAreaControlSequence,
  isTextAreaNewlineInput,
} from './textareaModel';

export type TuiKeyInput = {
  ctrl?: boolean;
  shift?: boolean;
  return?: boolean;
  escape?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  tab?: boolean;
  backspace?: boolean;
  delete?: boolean;
  home?: boolean;
  end?: boolean;
};

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

export type TuiInputBufferState = {
  pendingControlSequence: string;
};

export type NormalizedTuiInputEvent = {
  input: string;
  key: TuiKeyInput;
};

export function createInitialTuiInputBufferState(): TuiInputBufferState {
  return { pendingControlSequence: '' };
}

export function normalizeTuiInputEvent(
  input: string,
  key: TuiKeyInput,
  state: TuiInputBufferState,
): { state: TuiInputBufferState; event: NormalizedTuiInputEvent | null } {
  if (!input) {
    return {
      state: createInitialTuiInputBufferState(),
      event: { input, key },
    };
  }

  if (state.pendingControlSequence) {
    const combined = state.pendingControlSequence + input;
    if (isTerminalControlSequence(combined)) {
      return {
        state: createInitialTuiInputBufferState(),
        event: { input: combined, key: normalizeTerminalKeyInput(combined, key) },
      };
    }
    if (isTerminalControlSequencePrefix(combined)) {
      return {
        state: { pendingControlSequence: combined },
        event: null,
      };
    }
    return {
      state: createInitialTuiInputBufferState(),
      event: { input, key },
    };
  }

  if (isTerminalControlSequencePrefix(input)) {
    return {
      state: { pendingControlSequence: input },
      event: null,
    };
  }

  return {
    state: createInitialTuiInputBufferState(),
    event: { input, key: normalizeTerminalKeyInput(input, key) },
  };
}

export function resolveTuiKeyAction(
  input: string,
  key: TuiKeyInput,
  context: TuiKeyContext,
): TuiKeyAction {
  const isReturn = isReturnKeyInput(input, key);
  const isNewline = isTextAreaNewlineInput(input, key);
  const isControlSequence = isTextAreaControlSequence(input);

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

function isTerminalControlSequence(input: string) {
  return /^(?:\x1b)?\[[0-9;?]*[A-Za-z~]$/.test(input);
}

function isTerminalControlSequencePrefix(input: string) {
  return /^(?:\x1b)?\[[0-9;?]*$/.test(input);
}

function normalizeTerminalKeyInput(input: string, key: TuiKeyInput): TuiKeyInput {
  switch (input) {
    case '\x1b[3~':
    case '[3~':
      return { ...key, delete: true };
    default:
      return key;
  }
}
