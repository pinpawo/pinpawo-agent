import { useCallback, useMemo } from 'react';
import {
  applyTextAreaCommand,
  type TextAreaModel,
} from './input/textarea/engine';
import {
  measureTextAreaLayout,
  type TextAreaLayout,
} from './input/textarea/layout';
import {
  buildTextAreaViewModel,
  type TextAreaViewModel,
} from './input/textarea/viewModel';
import type { TextAreaCommand } from './input/textarea/commands';
import type { TuiAction, TuiState } from './state/tuiState';

type TextAreaInputState = Pick<TuiState['input'], 'text' | 'cursorOffset'>;

export type TextAreaComposerProps = {
  model: TextAreaViewModel;
};

export type TextAreaController = {
  value: string;
  cursorOffset: number;
  layout: TextAreaLayout;
  cursor: TextAreaLayout['cursor'];
  composerProps: TextAreaComposerProps;
  clear: () => void;
  applyCommand: (command: TextAreaCommand) => void;
};

export function useTextAreaController(options: {
  input: TextAreaInputState;
  focused: boolean;
  placeholder: string;
  width: number;
  dispatch: (action: TuiAction) => void;
}): TextAreaController {
  const { input, width, dispatch } = options;
  const clear = useCallback(() => {
    dispatch({ type: 'input.set', value: '', cursorOffset: 0 });
  }, [dispatch]);

  const applyCommand = useCallback((command: TextAreaCommand) => {
    dispatch({
      type: 'input.apply',
      value: applyTextAreaControllerCommand(input, command, width),
    });
  }, [dispatch, input, width]);

  const layout = useMemo(() => measureTextAreaControllerLayout(input, width), [input, width]);
  const composerProps = useMemo(() => buildTextAreaComposerProps(input, {
    focused: options.focused,
    placeholder: options.placeholder,
    width,
  }), [input, options.focused, options.placeholder, width]);

  return {
    value: input.text,
    cursorOffset: input.cursorOffset,
    layout,
    cursor: layout.cursor,
    composerProps,
    clear,
    applyCommand,
  };
}

export function buildTextAreaComposerProps(
  input: TextAreaInputState,
  options: {
    focused: boolean;
    placeholder: string;
    width: number;
  },
): TextAreaComposerProps {
  return {
    model: buildTextAreaViewModel({
      text: input.text,
      cursorOffset: input.cursorOffset,
      placeholder: options.placeholder,
      focused: options.focused,
      width: options.width,
    }),
  };
}

export function applyTextAreaControllerCommand(
  input: TextAreaInputState,
  command: TextAreaCommand,
  width: number,
): TextAreaModel {
  return applyTextAreaCommand(command, {
    text: input.text,
    cursorOffset: input.cursorOffset,
  }, { width });
}

export function measureTextAreaControllerLayout(
  input: TextAreaInputState,
  width: number,
): TextAreaLayout {
  return measureTextAreaLayout({
    text: input.text,
    cursorOffset: input.cursorOffset,
  }, width);
}
