import { parseTuiCommand } from './commandRegistry';

export type ComposerMode = 'chat';

export type ComposerIntent =
  | { type: 'none' }
  | { type: 'notice'; message: string }
  | { type: 'quit' }
  | { type: 'open-help' }
  | { type: 'refresh-session' }
  | { type: 'compact-session' }
  | { type: 'open-resume' }
  | { type: 'open-model' }
  | { type: 'open-policy' }
  | { type: 'open-transcript' }
  | { type: 'export-transcript'; path?: string }
  | { type: 'open-editor'; text: string }
  | { type: 'enter-chat' }
  | { type: 'start-new-session' }
  | { type: 'submit-chat'; text: string };

export function resolveComposerIntent(input: {
  text: string;
  attachmentCount: number;
  mode: ComposerMode;
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
    return { type: 'submit-chat', text: parsed.text };
  }

  switch (parsed.name) {
    case 'quit':
      return { type: 'quit' };
    case 'help':
      return { type: 'open-help' };
    case 'refresh':
      return { type: 'refresh-session' };
    case 'compact':
      return { type: 'compact-session' };
    case 'resume':
      return { type: 'open-resume' };
    case 'model':
      return { type: 'open-model' };
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
    case 'new':
      return { type: 'start-new-session' };
  }
}
