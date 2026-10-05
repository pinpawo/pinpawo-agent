import type { ThemeMode } from '@opentui/core';

export function welcomeColors(theme: ThemeMode | null) {
  return theme === 'light'
    ? {
        foreground: '#000000',
        background: '#f2f3f5',
        muted: '#56606b',
        status: '#226d40',
      }
    : {
        foreground: '#ffffff',
        background: '#22272e',
        muted: '#bcc2c9',
        status: '#7fcf9b',
      };
}

export type WelcomeColors = ReturnType<typeof welcomeColors>;
