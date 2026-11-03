import { parseArtifactUri, type Deliverable } from '@pinpawo/agent-contracts';
import type { AgentMessageEntry } from '@pinpawo/agent-session';
import { lexer, walkTokens } from 'marked';

/** Display-only links; never infer canonical deliverables from reply prose. */
export function messageDisplayReferences(entry: Pick<AgentMessageEntry, 'text' | 'deliverables'>): Deliverable[] {
  const references = new Map((entry.deliverables ?? []).map(reference => [reference.uri, reference]));
  const add = (uri: string, title?: string) => {
    try { parseArtifactUri(uri); } catch { return; }
    if (!references.has(uri)) references.set(uri, { uri, ...(title ? { title } : {}) });
  };
  walkTokens(lexer(entry.text), token => {
    if ((token.type === 'link' || token.type === 'image') && typeof token.href === 'string') {
      add(token.href, typeof token.text === 'string' ? token.text : undefined);
    } else if (token.type === 'text' && !token.tokens && typeof token.text === 'string') {
      for (const match of token.text.matchAll(/artifact:\/\/[^\s<>"`]+/gu)) {
        // URI segment encoding leaves apostrophes and exclamation marks intact.
        let uri = match[0].replace(/[.,;:?，。；：？]+$/u, '');
        // Bare links may have surrounding punctuation; balanced filename parentheses remain part of the key.
        for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
          while (uri.endsWith(close) && uri.split(close).length > uri.split(open).length) uri = uri.slice(0, -1);
        }
        add(uri);
      }
    }
  });
  return [...references.values()];
}
