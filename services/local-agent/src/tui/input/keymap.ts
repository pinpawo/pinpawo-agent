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

export type ComposerInputState = {
  value: string;
  cursorOffset: number;
};

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
        event: { input: combined, key },
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
    event: { input, key },
  };
}

export function resolveTuiKeyAction(
  input: string,
  key: TuiKeyInput,
  context: TuiKeyContext,
): TuiKeyAction {
  const isReturn = isReturnKeyInput(input, key);
  const isNewline = isComposerNewlineInput(input, key);
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
  if (key.upArrow || key.downArrow || key.tab || (key.shift && key.tab)) {
    return { type: 'none' };
  }
  if (isControlSequence) return { type: 'none' };

  return { type: 'composer.edit' };
}

export function applyComposerInput(
  input: string,
  key: TuiKeyInput,
  state: ComposerInputState,
): ComposerInputState {
  const cursorOffset = clampCursor(state.cursorOffset, state.value);
  let nextValue = state.value;
  let nextCursor = cursorOffset;

  if (key.ctrl) {
    switch (input) {
      case 'a':
        nextCursor = 0;
        break;
      case 'e':
        nextCursor = state.value.length;
        break;
      case 'k':
        nextValue = state.value.slice(0, cursorOffset);
        break;
      case 'u':
        nextValue = state.value.slice(cursorOffset);
        nextCursor = 0;
        break;
      case 'w': {
        const before = state.value.slice(0, cursorOffset);
        const trimmed = before.replace(/\s+$/, '');
        const wordStart = Math.max(0, trimmed.lastIndexOf(' ') + 1);
        nextValue = state.value.slice(0, wordStart) + state.value.slice(cursorOffset);
        nextCursor = wordStart;
        break;
      }
      default:
        return {
          value: state.value,
          cursorOffset,
        };
    }
  } else if (key.leftArrow) {
    nextCursor = Math.max(0, cursorOffset - 1);
  } else if (key.rightArrow) {
    nextCursor = Math.min(state.value.length, cursorOffset + 1);
  } else if (key.backspace || key.delete) {
    if (cursorOffset > 0) {
      nextValue = state.value.slice(0, cursorOffset - 1) + state.value.slice(cursorOffset);
      nextCursor = cursorOffset - 1;
    }
  } else if (isComposerNewlineInput(input, key)) {
    nextValue = state.value.slice(0, cursorOffset) + '\n' + state.value.slice(cursorOffset);
    nextCursor = cursorOffset + 1;
  } else {
    const text = normalizeComposerTextInput(input);
    if (!text) {
      return {
        value: state.value,
        cursorOffset,
      };
    }
    nextValue = state.value.slice(0, cursorOffset) + text + state.value.slice(cursorOffset);
    nextCursor = cursorOffset + text.length;
  }

  return {
    value: nextValue,
    cursorOffset: clampCursor(nextCursor, nextValue),
  };
}

function clampCursor(cursorOffset: number, value: string) {
  return Math.max(0, Math.min(value.length, cursorOffset));
}

function isReturnKeyInput(input: string, key: TuiKeyInput) {
  return (Boolean(key.return) && !key.shift) || input === '\r' || input === '\n' || input === '\r\n';
}

function isComposerNewlineInput(input: string, key: TuiKeyInput) {
  return Boolean(key.shift && key.return)
    || input === '\x1b[13;2u'
    || input === '\x1b[13;2~'
    || input === '\x1b[27;2;13~'
    || input === '[13;2u'
    || input === '[13;2~'
    || input === '[27;2;13~';
}

function isTerminalControlSequence(input: string) {
  return /^(?:\x1b)?\[[0-9;?]*[A-Za-z~]$/.test(input);
}

function isTerminalControlSequencePrefix(input: string) {
  return /^(?:\x1b)?\[[0-9;?]*$/.test(input);
}

function normalizeComposerTextInput(input: string) {
  if (!input || isTerminalControlSequence(input)) return '';
  const text = input.replace(/(?:\x1b)?\[200~([\s\S]*?)(?:\x1b)?\[201~/g, '$1');
  if (isTerminalControlSequence(text)) return '';
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}
