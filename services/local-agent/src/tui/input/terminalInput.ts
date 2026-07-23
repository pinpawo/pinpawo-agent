import type { TuiKeyInput } from './keyInput';

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

export function isTerminalControlSequence(input: string) {
  return /^(?:\x1b)?\[[0-9;?]*[A-Za-z~]$/.test(input)
    || /^(?:(?:\x1b)?\[<\d+;\d+;\d+[mM])+$/.test(input);
}

export function isTerminalControlSequencePrefix(input: string) {
  return /^(?:\x1b)?\[[0-9;?]*$/.test(input)
    || /^(?:\x1b)?\[<[\d;]*$/.test(input);
}
