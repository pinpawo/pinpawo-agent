import type { TextareaOptions } from '@opentui/core';

export const COMPOSER_PLACEHOLDER =
  'Message · Enter to send · Shift+Enter newline';

export const COMPOSER_KEY_BINDINGS = [
  {
    name: 'return',
    action: 'submit',
  },
  {
    name: 'kpenter',
    action: 'submit',
  },
  {
    name: 'return',
    shift: true,
    action: 'newline',
  },
  {
    name: 'kpenter',
    shift: true,
    action: 'newline',
  },
  {
    name: 'j',
    ctrl: true,
    action: 'newline',
  },
  {
    name: 'linefeed',
    action: 'newline',
  },
] satisfies NonNullable<TextareaOptions['keyBindings']>;
