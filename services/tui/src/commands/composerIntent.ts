import { parseTuiCommand } from './commandRegistry';

export type ComposerMode = 'chat' | 'studio';

export type ComposerIntent =
  | { type: 'none' }
  | { type: 'notice'; message: string }
  | { type: 'quit' }
  | { type: 'open-help' }
  | { type: 'continue-delegation'; guidance: string }
  | { type: 'open-resume' }
  | { type: 'open-policy' }
  | { type: 'open-transcript' }
  | { type: 'export-transcript'; path?: string }
  | { type: 'open-editor'; text: string }
  | { type: 'enter-chat' }
  | { type: 'enter-studio' }
  | { type: 'start-new-session' }
  | { type: 'submit-chat'; text: string }
  | { type: 'submit-studio'; text: string; enterMode: boolean };

export function resolveComposerIntent(input: {
  text: string;
  attachmentCount: number;
  mode: ComposerMode;
  canContinueActiveDelegation: boolean;
}): ComposerIntent {
  const parsed = input.attachmentCount === 0
    ? parseTuiCommand(input.text)
    : { type: 'text' as const, text: input.text };

  if (parsed.type === 'empty') return { type: 'none' };
  if (parsed.type === 'unknown') {
    return {
      type: 'notice',
      message: `unknown command: ${parsed.raw} · use /help`,
    };
  }
  if (parsed.type === 'text') {
    return input.mode === 'studio'
      ? { type: 'submit-studio', text: parsed.text, enterMode: false }
      : { type: 'submit-chat', text: parsed.text };
  }

  switch (parsed.name) {
    case 'quit':
      return { type: 'quit' };
    case 'help':
      return { type: 'open-help' };
    case 'continue':
      if (!parsed.args) {
        return {
          type: 'notice',
          message: 'provide guidance: /continue <guidance>',
        };
      }
      if (!input.canContinueActiveDelegation) {
        return {
          type: 'notice',
          message: 'no suspended delegation is available for this session',
        };
      }
      return {
        type: 'continue-delegation',
        guidance: parsed.args,
      };
    case 'resume':
      return { type: 'open-resume' };
    case 'policy':
      return { type: 'open-policy' };
    case 'transcript':
      return { type: 'open-transcript' };
    case 'export':
      return {
        type: 'export-transcript',
        ...(parsed.args ? { path: parsed.args } : {}),
      };
    case 'edit':
      return { type: 'open-editor', text: parsed.args };
    case 'chat':
      return { type: 'enter-chat' };
    case 'studio':
      if (parsed.args) {
        return { type: 'submit-studio', text: parsed.args, enterMode: true };
      }
      return input.mode === 'studio'
        ? { type: 'enter-chat' }
        : { type: 'enter-studio' };
    case 'new':
      return { type: 'start-new-session' };
  }
}
