import { parseTuiCommand } from './commandRegistry';
import { parseArtifactUri } from '@pinpawo/agent-contracts';

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
  | { type: 'download-artifact'; uri: string }
  | { type: 'open-editor'; text: string }
  | { type: 'copy-latest-reply' }
  | { type: 'enter-chat' }
  | { type: 'start-new-session' }
  | { type: 'submit-chat'; text: string };

export function resolveComposerIntent(input: {
  text: string;
  attachmentCount: number;
  mode: ComposerMode;
}): ComposerIntent {
  const command = parseTuiCommand(input.text);
  const parsed = input.attachmentCount === 0 || (command.type === 'command' && command.name === 'download')
    ? command
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
    case 'download':
      if (input.attachmentCount) return { type: 'notice', message: 'Remove attachments before downloading an artifact.' };
      try {
        parseArtifactUri(parsed.args);
        return { type: 'download-artifact', uri: parsed.args };
      } catch {
        return { type: 'notice', message: 'usage: /download <artifact-uri>' };
      }
    case 'edit':
      return { type: 'open-editor', text: parsed.args };
    case 'copy':
      return parsed.args
        ? { type: 'notice', message: 'usage: /copy' }
        : { type: 'copy-latest-reply' };
    case 'chat':
      return { type: 'enter-chat' };
    case 'new':
      return { type: 'start-new-session' };
  }
}
