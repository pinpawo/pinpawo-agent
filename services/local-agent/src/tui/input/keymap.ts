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
  | { type: 'approval.dismiss' }
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

export function resolveTuiKeyAction(
  input: string,
  key: TuiKeyInput,
  context: TuiKeyContext,
): TuiKeyAction {
  if (key.ctrl && input === 'c') {
    return { type: 'global.ctrl_c' };
  }

  if (!context.ready) {
    return { type: 'none' };
  }

  if (context.hasResumePicker) {
    if (key.upArrow) return { type: 'resume.previous' };
    if (key.downArrow) return { type: 'resume.next' };
    if (key.return) return { type: 'resume.submit' };
    if (key.escape) return { type: 'resume.dismiss' };
    return { type: 'none' };
  }

  if (context.hasPendingApproval) {
    if (key.upArrow) return { type: 'approval.previous' };
    if (key.downArrow) return { type: 'approval.next' };
    if (key.return) return { type: 'approval.submit' };
    if (key.escape) return { type: 'approval.dismiss' };
    if (key.tab || (key.shift && key.tab)) return { type: 'none' };
    return { type: 'composer.edit' };
  }

  if (context.busy) {
    if (key.escape) return { type: 'global.interrupt' };
    return { type: 'none' };
  }

  if (key.escape) return { type: 'composer.clear' };
  if (key.return) return { type: 'composer.submit' };
  if (key.upArrow || key.downArrow || key.tab || (key.shift && key.tab)) {
    return { type: 'none' };
  }

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
  } else {
    nextValue = state.value.slice(0, cursorOffset) + input + state.value.slice(cursorOffset);
    nextCursor = cursorOffset + input.length;
  }

  return {
    value: nextValue,
    cursorOffset: clampCursor(nextCursor, nextValue),
  };
}

function clampCursor(cursorOffset: number, value: string) {
  return Math.max(0, Math.min(value.length, cursorOffset));
}
